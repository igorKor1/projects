const path = require("path");
const jsonServer = require("json-server");
const multer = require("multer");
const cors = require("cors");
const { OpenAI } = require("openai");
const { createClient } = require("@supabase/supabase-js");
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

    res.json(article);
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

// === HuggingFace / OpenAI route ===
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
