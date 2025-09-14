const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const jsonServer = require("json-server");
const multer = require("multer");
const cors = require("cors");
const { OpenAI } = require("openai");
const { supabase } = require("../lib/supabase");
const { calcStreak } = require("../utils/calcStreak");
const { recalcLearnedPercent } = require("../utils/recalcLearnedPercent");
const {
  recalcCompletedExercisesPercent,
} = require("../utils/recalcCompletedExercisesPercent");

const storageMemory = multer.memoryStorage();
const uploadMemory = multer({
  storage: storageMemory,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images are allowed"), false);
    }
    cb(null, true);
  },
});

const { v4: uuidv4 } = require("uuid");

const HF_TOKEN = process.env.HF_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!HF_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing ENV vars: HF_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const client = new OpenAI({
  apiKey: HF_TOKEN,
  baseURL: "https://router.huggingface.co/v1",
});

function getPublicImageUrl(bucket, path) {
  if (!path) return null;

  const cleanPath = path.replace(/^images\//, "").replace(/^\/+/, "");

  return `https://aiqxwhlrhvyyrthdhkov.supabase.co/storage/v1/object/public/${bucket}/${cleanPath}`;
}

const DEFAULT_AVATAR_URL =
  "https://i.pinimg.com/1200x/3e/96/18/3e96181466ad44946c3af75fb71e7788.jpg";

const server = jsonServer.create();
server.use(jsonServer.defaults());
server.use(jsonServer.bodyParser);
server.use(cors());

server.post("/login", async (req, res) => {
  try {
    const { username, password, email } = req.body;

    let query = supabase
      .from("users")
      .select("*")
      .eq("password", password)
      .limit(1);

    if (email) query = query.eq("email", email);
    else query = query.eq("username", username);

    const { data: user, error } = await query.single();

    if (error || !user)
      return res.status(403).json({ message: "User not found" });
    return res.json(user);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

server.post("/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const { data: existingUsername, error: usernameError } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .limit(1);
    if (usernameError)
      return res.status(500).json({ message: usernameError.message });
    if (existingUsername.length > 0)
      return res.status(400).json({ message: "Username already exists" });

    const { data: existingEmail, error: emailError } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .limit(1);
    if (emailError)
      return res.status(500).json({ message: emailError.message });
    if (existingEmail.length > 0)
      return res.status(400).json({ message: "Email already exists" });

    const { data: user, error: insertError } = await supabase
      .from("users")
      .insert([{ username, password, email, avatar: DEFAULT_AVATAR_URL }])
      .select()
      .single();
    if (insertError)
      return res.status(500).json({ message: insertError.message });

    const { error: profileError } = await supabase.from("profile").insert([
      {
        user_id: user.id,
        name: username,
        lastname: "",
        age: null,
        currency: "USD",
        country: "",
        city: "",
        avatar: user.avatar,
        primarycolor: "#00bfff",
        secondarycolor: "#ff6347",
      },
    ]);
    if (profileError)
      return res.status(500).json({ message: profileError.message });

    const { error: streakError } = await supabase
      .from("user_streak")
      .insert([{ user_id: user.id, streak: 0, last_activity: null }]);
    if (streakError)
      console.error("Error creating initial streak:", streakError.message);

    res.status(201).json(user);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.use((req, res, next) => {
  if (!req.headers.authorization)
    return res.status(403).json({ message: "AUTH ERROR" });
  next();
});

server.get("/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const { data: profile, error } = await supabase
      .from("profile")
      .select("*")
      .eq("user_id", Number(userId))
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json(profile);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.put("/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const { data, error } = await supabase
      .from("profile")
      .update(updates)
      .eq("user_id", Number(userId))
      .select()
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    if (!data) {
      return res.status(404).json({ message: "Profile not found" });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/articles", async (req, res) => {
  try {
    let { _limit, _page, _sort, _order, q, type } = req.query;

    _limit = parseInt(_limit) || 10;
    _page = parseInt(_page) || 1;
    _order = (_order || "desc").toLowerCase();

    const filters = (query) => {
      if (q) query = query.ilike("title", `%${q}%`);
      if (type && type !== "ALL") query = query.contains("type", [type]);
      return query;
    };

    const from = (_page - 1) * _limit;
    const to = from + _limit;
    let query = supabase
      .from("articles")
      .select(`*, user:users(id, username, avatar), blocks:article_blocks(*)`);
    query = filters(query);

    if (_sort) query = query.order(_sort, { ascending: _order === "asc" });
    query = query.range(from, to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const hasNextPage = data.length > _limit;
    const articles = data.slice(0, _limit).map((article) => ({
      ...article,
      img: getPublicImageUrl("article-images", article.img),
    }));

    res.json({ data: articles, hasNextPage });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/exercises/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: exercise, error: exerciseError } = await supabase
      .from("exercises")
      .select("*")
      .eq("id", id)
      .single();

    if (exerciseError || !exercise) {
      return res.status(404).json({ message: "Exercise not found" });
    }

    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select(
        `
        *,
        options:question_options(*)
      `
      )
      .eq("exercise_id", id)
      .order("id", { ascending: true });

    if (questionsError)
      return res.status(500).json({ message: questionsError.message });

    res.json({
      ...exercise,
      image: getPublicImageUrl("exercise-images", exercise.image),
      questions,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/articles/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: article, error } = await supabase
      .from("articles")
      .select(
        `
        *,
        user:users(id, username, avatar),
        blocks:article_blocks(*)
      `
      )
      .eq("id", id)
      .single();

    if (error || !article) {
      return res.status(404).json({ message: "Article not found" });
    }

    const articleImgUrl = getPublicImageUrl("article-images", article.img);

    const blocksWithPublicSrc = article.blocks.map((block) => ({
      ...block,
      src: block.src
        ? getPublicImageUrl("articl-block-images", block.src)
        : null,
    }));

    res.json({
      ...article,
      img: articleImgUrl,
      blocks: blocksWithPublicSrc,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/recommendations", async (req, res) => {
  try {
    const { _limit } = req.query;
    const limit = parseInt(_limit) || 10;

    const { data, error } = await supabase
      .from("articles")
      .select("id, img, subtitle, title")
      .order("created_at", { ascending: false })
      .range(0, limit - 1);

    if (error) return res.status(500).json({ message: error.message });

    res.json(data || []);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/comments", async (req, res) => {
  try {
    const { articleId } = req.query;

    if (!articleId) {
      return res.status(400).json({ message: "articleId is required" });
    }

    const { data, error } = await supabase
      .from("comments")
      .select(
        `
        *,
        user:users(id, username, avatar)
      `
      )
      .eq("articleid", articleId)
      .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    res.json(data || []);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.post("/comments", async (req, res) => {
  try {
    const { text, articleId, userId } = req.body;

    if (!text || !articleId) {
      return res
        .status(400)
        .json({ message: "text and articleId are required" });
    }

    const { data, error } = await supabase
      .from("comments")
      .insert([
        {
          text,
          articleid: articleId,
          userid: userId || null,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // подтягиваем user для фронта
    const { data: commentWithUser, error: userError } = await supabase
      .from("comments")
      .select(
        `
        *,
        user:users(id, username, avatar)
      `
      )
      .eq("id", data.id)
      .single();

    if (userError) return res.status(500).json({ message: userError.message });

    res.status(201).json(commentWithUser);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/exercises", async (req, res) => {
  try {
    let { _limit, _page, type } = req.query;

    _limit = parseInt(_limit) || 10;
    _page = parseInt(_page) || 1;

    const from = (_page - 1) * _limit;
    const to = from + _limit;

    let query = supabase.from("exercises").select("*", { count: "exact" });

    if (type && type !== "ALL") {
      query = query.contains("type", [type]);
    }

    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ message: error.message });

    const hasNextPage = data.length > _limit;

    const exercises = data.slice(0, _limit).map((ex) => ({
      ...ex,
      image: getPublicImageUrl("exercise-images", ex.image),
    }));

    res.set("X-Total-Count", count || 0);
    res.json({ data: exercises, hasNextPage });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/streak/:userId", async (req, res) => {
  const { userId } = req.params;
  console.log(userId, "userId");

  const { data, error } = await supabase
    .from("user_streak")
    .select("*")
    .eq("user_id", Number(userId))
    .single();

  if (error) return res.status(500).json({ message: error.message });

  res.json(data);
});

server.post("/exercise-results", async (req, res) => {
  try {
    const { user_id, exercises, result_uuid } = req.body;
    if (!user_id || !exercises)
      return res.status(400).json({ message: "Missing required fields" });

    const today = new Date().toISOString().split("T")[0];

    const { data: existing, error: fetchError } = await supabase
      .from("exercise_results")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116")
      return res.status(500).json({ message: fetchError.message });

    let updatedExercises = [];

    if (existing) {
      updatedExercises = [...existing.exercises];

      exercises.forEach((ex) => {
        const exerciseIndex = updatedExercises.findIndex(
          (e) => e.exercise_id == ex.exercise_id
        );

        if (exerciseIndex !== -1) {
          ex.exerciseResults.forEach((resItem) => {
            const exists = updatedExercises[exerciseIndex].exerciseResults.some(
              (r) => r.question_id == resItem.question_id
            );
            if (!exists) {
              updatedExercises[exerciseIndex].exerciseResults.push({
                ...resItem,
                date: today,
              });
            }
          });
        } else {
          updatedExercises.push({
            ...ex,
            exerciseResults: ex.exerciseResults.map((r) => ({
              ...r,
              date: today,
            })),
          });
        }
      });

      await supabase
        .from("exercise_results")
        .update({
          exercises: updatedExercises,
          result_uuid: result_uuid || existing.result_uuid,
        })
        .eq("user_id", user_id);
    } else {
      updatedExercises = exercises.map((ex) => ({
        ...ex,
        exerciseResults: ex.exerciseResults.map((r) => ({
          ...r,
          date: today,
        })),
      }));

      await supabase.from("exercise_results").insert([
        {
          user_id,
          exercises: updatedExercises,
          result_uuid: result_uuid || uuidv4(),
        },
      ]);
    }

    const streak = calcStreak(updatedExercises, today);

    const { data: streakData } = await supabase
      .from("user_streak")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (streakData) {
      await supabase
        .from("user_streak")
        .update({ streak, last_activity: today, updated_at: new Date() })
        .eq("user_id", user_id);
    } else {
      await supabase
        .from("user_streak")
        .insert({ user_id, streak, last_activity: today });
    }

    const { completedCount, percent } = await recalcCompletedExercisesPercent(
      user_id,
      supabase
    );

    res.status(201).json({ message: "Saved", streak, completedCount, percent });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /exercise-results/:id
server.put("/exercise-results/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { exercises, result_uuid } = req.body;

    if (!exercises)
      return res.status(400).json({ message: "Missing exercises data" });

    const { data, error } = await supabase
      .from("exercise_results")
      .update({ exercises, result_uuid })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    const parsedExercises = Array.isArray(data.exercises)
      ? data.exercises
      : JSON.parse(data.exercises);

    const { completedCount, percent } = await recalcCompletedExercisesPercent(
      data.user_id,
      supabase
    );

    res.json({
      ...data,
      exercises: parsedExercises,
      completedCount,
      percent,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/exercise-results", async (req, res) => {
  try {
    const { userId, exerciseId } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    // достаём все результаты пользователя
    const { data, error } = await supabase
      .from("exercise_results")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    let filtered = (data || []).filter((d) => {
      // Преобразуем строку в JSON, если нужно
      const exercises = Array.isArray(d.exercises)
        ? d.exercises
        : JSON.parse(d.exercises);

      // Фильтруем по exerciseId
      return (
        !exerciseId || exercises.some((ex) => ex.exercise_id == exerciseId)
      );
    });

    // Отдаём пустой массив, если нет совпадений
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.post("/progress", async (req, res) => {
  try {
    const { user_id, user_data } = req.body;
    if (!user_id || !user_data)
      return res.status(400).json({ message: "Missing required fields" });

    const { data: existing, error: fetchError } = await supabase
      .from("progress")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116")
      return res.status(500).json({ message: fetchError.message });

    if (existing) {
      const updatedUserData = [...existing.user_data];

      user_data.forEach((newEx) => {
        const idx = updatedUserData.findIndex(
          (e) => e.exercise_id == newEx.exercise_id
        );
        if (idx !== -1) {
          // обновляем существующую запись
          updatedUserData[idx] = { ...updatedUserData[idx], ...newEx };
        } else {
          updatedUserData.push(newEx);
        }
      });

      const { data, error } = await supabase
        .from("progress")
        .update({ user_data: updatedUserData })
        .eq("user_id", user_id)
        .select()
        .single();

      if (error) return res.status(500).json({ message: error.message });
      return res.json(data);
    } else {
      const { data, error } = await supabase
        .from("progress")
        .insert([{ user_id, user_data }])
        .select()
        .single();

      if (error) return res.status(500).json({ message: error.message });
      return res.status(201).json(data);
    }
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.put("/progress/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, user_data } = req.body;

    if (!user_id || !user_data) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("progress")
      .update({ user_id, user_data })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // camelCase для фронта
    res.json({
      ...data,
      id: data.id,
      userId: data.user_id,
      userData: data.user_data,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/progress", async (req, res) => {
  try {
    const { userId, exerciseId } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const { data, error } = await supabase
      .from("progress")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    let filtered = (data || []).map((d) => {
      const user_data = Array.isArray(d.user_data)
        ? d.user_data
        : JSON.parse(d.user_data);

      return {
        ...d,
        user_data,
      };
    });

    if (exerciseId) {
      filtered = filtered.filter((d) =>
        d.user_data.some((ex) => ex.exercise_id == exerciseId)
      );
    }

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/words", async (req, res) => {
  try {
    const { topic, userId } = req.query;
    if (!userId) return res.status(400).json({ message: "userId required" });

    let query = supabase
      .from("words")
      .select(
        `
        id,
        word,
        translation,
        example,
        type,
        topic:topics(name),
        isLearned
      `
      )
      .eq("user_id", userId);

    if (topic) query = query.eq("topics.name", topic);

    const { data, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const groups = [];
    const groupMap = {};

    data.forEach((word) => {
      const topicName = word.topic?.name || "unknown";
      if (!groupMap[topicName]) groupMap[topicName] = [];
      groupMap[topicName].push(word);
    });

    for (const [topicName, items] of Object.entries(groupMap)) {
      groups.push({ id: topicName, items });
    }

    res.json(groups);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.put("/words/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, isLearned } = req.body;

    if (!user_id || typeof isLearned !== "boolean") {
      return res
        .status(400)
        .json({ message: "user_id and isLearned required" });
    }

    const { data: updatedWord, error: updateError } = await supabase
      .from("words")
      .update({ isLearned })
      .eq("id", id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (updateError)
      return res.status(500).json({ message: updateError.message });

    const learned_words_percent = await recalcLearnedPercent(user_id, supabase);

    const { error: userUpdateError } = await supabase
      .from("users")
      .update({ learned_words_percent })
      .eq("id", user_id);

    if (userUpdateError)
      return res.status(500).json({ message: userUpdateError.message });

    res.json({ ...updatedWord, learned_words_percent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message });
  }
});

server.post("/words", async (req, res) => {
  try {
    const { user_id, topic, digit } = req.body;
    if (!user_id || !topic || !digit)
      return res
        .status(400)
        .json({ message: "user_id, topic and digit required" });

    // Get or create topic
    let { data: topicData } = await supabase
      .from("topics")
      .select("id")
      .eq("name", topic)
      .eq("user_id", user_id)
      .single();

    if (!topicData) {
      const { data: newTopic } = await supabase
        .from("topics")
        .insert([{ name: topic, user_id }])
        .select()
        .single();
      topicData = newTopic;
    }

    // Generate words using AI
    const completion = await client.chat.completions.create({
      model: "openai/gpt-oss-120b:nscale",
      messages: [
        {
          role: "user",
          content: `
Generate exactly ${digit} real English words related to the topic "${topic}".
Rules:
- Use only real words from Cambridge Dictionary.
- Provide ONLY a JSON array of objects with:
  "word", "translation", "example", "type"
- Ensure valid JSON with double quotes.
- Do not add explanations or extra text outside the JSON.
        `,
        },
      ],
      max_tokens: 900,
      temperature: 0.9,
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const match = content.match(/\[.*\]/s);
    if (!match)
      return res
        .status(500)
        .json({ message: "No JSON array found in model response" });

    const parsed = JSON.parse(match[0]);

    // Filter out existing words
    const { data: existingWords } = await supabase
      .from("words")
      .select("word")
      .eq("user_id", user_id)
      .eq("topic_id", topicData.id);

    const existingSet = new Set(existingWords?.map((w) => w.word));
    const newWords = parsed.filter((w) => !existingSet.has(w.word));

    if (newWords.length === 0) {
      const learned_words_percent = await recalcLearnedPercent(
        user_id,
        supabase
      );
      await supabase
        .from("users")
        .update({ learned_words_percent })
        .eq("id", user_id);

      return res.json({
        message: "No new words to add",
        items: [],
        learned_words_percent,
      });
    }

    // Insert new words
    const wordPayload = newWords.map((w) => ({
      word: w.word,
      translation: w.translation,
      example: w.example,
      type: w.type,
      topic_id: topicData.id,
      user_id,
      isLearned: false,
    }));

    const { data: insertedWords, error } = await supabase
      .from("words")
      .insert(wordPayload)
      .select();

    if (error) return res.status(500).json({ message: error.message });

    // Recalculate learned words percent
    const learned_words_percent = await recalcLearnedPercent(user_id, supabase);
    await supabase
      .from("users")
      .update({ learned_words_percent })
      .eq("id", user_id);

    res.json({
      topic_id: topicData.id,
      items: insertedWords,
      learned_words_percent,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message });
  }
});

server.put("/words", async (req, res) => {
  try {
    const { user_id, topic, digit } = req.body;
    if (!user_id || !topic || !digit)
      return res
        .status(400)
        .json({ message: "user_id, topic and digit required" });

    // Get or create topic
    let { data: topicData } = await supabase
      .from("topics")
      .select("id")
      .eq("name", topic)
      .eq("user_id", user_id)
      .single();

    if (!topicData) {
      const { data: newTopic } = await supabase
        .from("topics")
        .insert([{ name: topic, user_id }])
        .select()
        .single();
      topicData = newTopic;
    }

    // Generate words using AI
    const completion = await client.chat.completions.create({
      model: "moonshotai/Kimi-K2-Instruct-0905",
      provider: "together",
      messages: [
        {
          role: "user",
          content: `
Generate exactly ${digit} real English words related to the topic "${topic}".
Rules:
- Use only real words from Cambridge Dictionary.
- Provide ONLY a JSON array of objects.
- Each object must include:
  "word": string,
  "translation": string,
  "example": string,
  "type": string ("${topic}")
- Ensure valid JSON with double quotes.
- Do not add any explanations or extra text outside the JSON.
        `,
        },
      ],
      max_tokens: 900,
      temperature: 0.9,
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const match = content.match(/\[.*\]/s);
    if (!match)
      return res
        .status(500)
        .json({ message: "No JSON array found in model response" });

    const parsed = JSON.parse(match[0]);

    // Filter out existing words
    const { data: existingWords } = await supabase
      .from("words")
      .select("word")
      .eq("user_id", user_id)
      .eq("topic_id", topicData.id);

    const existingSet = new Set(existingWords?.map((w) => w.word));
    const newWords = parsed.filter((w) => !existingSet.has(w.word));

    if (newWords.length === 0) {
      const learned_words_percent = await recalcLearnedPercent(
        user_id,
        supabase
      );
      await supabase
        .from("users")
        .update({ learned_words_percent })
        .eq("id", user_id);

      return res.json({
        message: "No new words to add",
        items: [],
        learned_words_percent,
      });
    }

    // Insert new words
    const wordPayload = newWords.map((w) => ({
      word: w.word,
      translation: w.translation,
      example: w.example,
      type: w.type,
      topic_id: topicData.id,
      user_id,
      isLearned: false,
    }));

    const { data: insertedWords, error } = await supabase
      .from("words")
      .insert(wordPayload)
      .select();

    if (error) return res.status(500).json({ message: error.message });

    // Recalculate learned words percent
    const learned_words_percent = await recalcLearnedPercent(user_id, supabase);
    await supabase
      .from("users")
      .update({ learned_words_percent })
      .eq("id", user_id);

    res.json({
      topic_id: topicData.id,
      items: insertedWords,
      learned_words_percent,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message });
  }
});

server.post(
  "/upload-avatar",
  uploadMemory.single("avatar"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { userId } = req.body;
      const filename = `avatars/${userId || "anon"}-${Date.now()}-${
        req.file.originalname
      }`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filename, req.file.buffer, {
          cacheControl: "3600",
          upsert: false,
          contentType: req.file.mimetype,
        });

      if (uploadError) {
        console.error("Supabase upload error:", uploadError);
        return res.status(500).json({ message: uploadError.message });
      }

      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filename);

      const publicUrl = publicUrlData.publicUrl;

      if (userId) {
        await supabase
          .from("profile")
          .update({ avatar: publicUrl })
          .eq("user_id", Number(userId));
      }

      res.json({ url: publicUrl });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: e.message });
    }
  }
);

if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 8000;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// for Vercel
module.exports = server;
