const path = require("path");
const jsonServer = require("json-server");
const multer = require("multer");
const cors = require("cors");
const { OpenAI } = require("openai");
const { createClient } = require("@supabase/supabase-js");

const { v4: uuidv4 } = require("uuid");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = jsonServer.create();
server.use(jsonServer.defaults());
server.use(jsonServer.bodyParser);
server.use(cors());

// === Uploads (локально, на Vercel — не будет работать, надо будет s3 / supabase storage) ===
const uploadsDir = path.resolve(__dirname, "../uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// === Delay middleware ===
server.use(async (req, res, next) => {
  await new Promise((r) => setTimeout(r, 800));
  next();
});

// === Auth & Profile routes ===
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
    if (!username || !password || !email)
      return res.status(400).json({ message: "All fields are required" });

    // check existing
    const { data: existing, error: checkError } = await supabase
      .from("users")
      .select("id")
      .or(`username.eq.${username},email.eq.${email}`)
      .limit(1);

    if (checkError)
      return res.status(500).json({ message: checkError.message });
    if (existing.length)
      return res.status(400).json({ message: "User exists" });

    // insert user
    const { data: user, error } = await supabase
      .from("users")
      .insert([
        {
          username,
          password,
          email,
          avatar: `https://i.pravatar.cc/150?u=${username}`,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // create profile
    await supabase
      .from("profile")
      .insert([{ id: user.id, username, avatar: user.avatar }]);

    res.status(201).json(user);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

server.use((req, res, next) => {
  if (!req.headers.authorization)
    return res.status(403).json({ message: "AUTH ERROR" });
  next();
});

server.get("/profile/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profile")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) return res.status(404).json({ message: "Not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/articles", async (req, res) => {
  try {
    let { _limit, _page, _sort, _order, q, type, _expand } = req.query;

    _limit = parseInt(_limit) || 10;
    _page = parseInt(_page) || 1;
    _order = (_order || "desc").toLowerCase();

    let query = supabase.from("articles").select(
      `
        *,
        user:users(id, username, avatar),
        blocks:article_blocks(*)
      `,
      { count: "exact" }
    );

    if (q) {
      query = query.ilike("title", `%${q}%`);
    }

    if (type && type !== "ALL") {
      query = query.contains("type", [type]);
    }

    if (_sort) {
      query = query.order(_sort, { ascending: _order === "asc" });
    }

    const from = (_page - 1) * _limit;
    const to = from + _limit - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ message: error.message });

    res.set("X-Total-Count", count || 0);
    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/exercises/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Получаем упражнение
    const { data: exercise, error: exerciseError } = await supabase
      .from("exercises")
      .select("*")
      .eq("id", id)
      .single();

    if (exerciseError || !exercise) {
      return res.status(404).json({ message: "Exercise not found" });
    }

    // 2. Получаем вопросы с их опциями
    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select(
        `
        *,
        options:question_options(*)   -- в Supabase можно вложенно
      `
      )
      .eq("exercise_id", id)
      .order("id", { ascending: true });

    if (questionsError)
      return res.status(500).json({ message: questionsError.message });

    // 3. Возвращаем полностью структуру
    res.json({
      ...exercise,
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
      .select("*")
      .eq("id", id)
      .single();

    if (error || !article) {
      return res.status(404).json({ message: "Article not found" });
    }

    res.json(article);
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

    let query = supabase.from("exercises").select("*", { count: "exact" });

    if (type && type !== "ALL") {
      query = query.contains("type", [type]);
    }

    const from = (_page - 1) * _limit;
    const to = from + _limit - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ message: error.message });

    res.set("X-Total-Count", count || 0);
    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.post("/exercise-results", async (req, res) => {
  try {
    const { user_id, exercises, result_uuid } = req.body;
    if (!user_id || !exercises)
      return res.status(400).json({ message: "Missing required fields" });

    // Получаем существующие результаты
    const { data: existing, error: fetchError } = await supabase
      .from("exercise_results")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116")
      return res.status(500).json({ message: fetchError.message });

    if (existing) {
      // Объединяем старые и новые упражнения, фильтруя дубликаты по exercise_id + question_id
      const updatedExercises = [...existing.exercises];

      exercises.forEach((ex) => {
        ex.exerciseResults.forEach((resItem) => {
          const exists = updatedExercises
            .find((e) => e.exercise_id == ex.exercise_id)
            ?.exerciseResults.some((r) => r.question_id == resItem.question_id);
          if (!exists) {
            const idx = updatedExercises.findIndex(
              (e) => e.exercise_id == ex.exercise_id
            );
            if (idx !== -1) updatedExercises[idx].exerciseResults.push(resItem);
            else updatedExercises.push(ex);
          }
        });
      });

      const { data, error } = await supabase
        .from("exercise_results")
        .update({
          exercises: updatedExercises,
          result_uuid: result_uuid || existing.result_uuid,
        })
        .eq("user_id", user_id)
        .select()
        .single();

      if (error) return res.status(500).json({ message: error.message });
      return res.json(data);
    } else {
      const { data, error } = await supabase
        .from("exercise_results")
        .insert([{ user_id, exercises, result_uuid: result_uuid || uuidv4() }])
        .select()
        .single();

      if (error) return res.status(500).json({ message: error.message });
      return res.status(201).json(data);
    }
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.put("/exercise-results/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { exercises, result_uuid } = req.body;

    if (!exercises) {
      return res.status(400).json({ message: "Missing exercises data" });
    }

    // Обновляем запись по id
    const { data, error } = await supabase
      .from("exercise_results")
      .update({ exercises, result_uuid })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });

    // Если exercises хранится как JSON-строка, можно парсить
    const parsedExercises = Array.isArray(data.exercises)
      ? data.exercises
      : JSON.parse(data.exercises);

    res.json({
      ...data,
      exercises: parsedExercises,
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

server.post("/generate-words", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ message: "Topic required" });

    const completion = await client.chat.completions.create({
      model: "openai/gpt-oss-120b:nscale",
      messages: [
        {
          role: "user",
          content: `Generate 5 new words on topic "${topic}" in JSON array only.`,
        },
      ],
      max_tokens: 900,
      temperature: 0.9,
    });

    let content = completion.choices?.[0]?.message?.content || "";
    const match = content.match(/\[.*\]/s);
    if (!match) return res.status(500).json({ message: "No JSON array found" });

    let parsed = JSON.parse(match[0]);

    // save in supabase
    await supabase.from("wordsCache").insert([{ topic, words: parsed }]);

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/wordsCache", async (req, res) => {
  try {
    const { data, error } = await supabase.from("wordsCache").select("*");
    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// === Upload avatar (локально работает, на Vercel нужен Supabase Storage) ===
server.post("/upload-avatar", upload.single("avatar"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 8000;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// === Экспорт для Vercel ===
module.exports = server;
