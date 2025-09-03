const fs = require("fs");
const path = require("path");
const jsonServer = require("json-server");
const multer = require("multer");
const cors = require("cors");
const { OpenAI } = require("openai");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.error("HF_TOKEN is not set in .env!");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: HF_TOKEN,
  baseURL: "https://router.huggingface.co/v1",
});

const server = jsonServer.create();
const router = jsonServer.router(path.resolve(__dirname, "../db.json"));
server.use(jsonServer.defaults());
server.use(jsonServer.bodyParser);
server.use(cors());

// Uploads folder
const uploadsDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// Delay middleware
server.use(async (req, res, next) => {
  await new Promise((r) => setTimeout(r, 800));
  next();
});

// Serve uploads
server.use("/uploads", require("express").static(uploadsDir));

// === Auth & Profile routes ===
server.post("/login", (req, res) => {
  try {
    const { username, password, email } = req.body;
    const db = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../db.json"), "UTF-8")
    );
    const users = db.users || [];
    const user = email
      ? users.find((u) => u.email === email && u.password === password)
      : users.find((u) => u.username === username && u.password === password);

    if (user) return res.json(user);
    return res.status(403).json({ message: "User not found" });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

server.post("/register", (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password || !email)
      return res.status(400).json({ message: "All fields are required" });

    const dbPath = path.resolve(__dirname, "../db.json");
    const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    db.users = db.users || [];

    if (db.users.find((u) => u.username === username))
      return res.status(400).json({ message: "Username exists" });
    if (db.users.find((u) => u.email === email))
      return res.status(400).json({ message: "Email exists" });

    const id = db.users.length ? Math.max(...db.users.map((u) => u.id)) + 1 : 1;
    const newUser = {
      id,
      username,
      password,
      email,
      avatar: `https://i.pravatar.cc/150?u=${username}`,
    };
    db.users.push(newUser);

    db.profile = db.profile || [];
    db.profile.push({
      id: id.toString(),
      username,
      name: "",
      lastName: "",
      age: null,
      avatar: newUser.avatar,
    });

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
    return res.status(201).json(newUser);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

server.use((req, res, next) => {
  if (!req.headers.authorization)
    return res.status(403).json({ message: "AUTH ERROR" });
  next();
});

server.get("/profile/:id", (req, res) => {
  try {
    const db = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../db.json"), "utf-8")
    );
    const profile = db.profile.find((p) => p.id === req.params.id);
    if (!profile) return res.status(404).json({ message: "Not found" });
    res.json(profile);
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
    const dbPath = path.resolve(__dirname, "../db.json");
    const db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    db.wordsCache = db.wordsCache || {};
    db.wordsCache[topic] = (db.wordsCache[topic] || []).concat(parsed);
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
    res.json(db.wordsCache[topic]);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

server.get("/wordsCache", (req, res) => {
  try {
    const db = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../db.json"), "utf-8")
    );
    res.json(db.wordsCache || []);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// === Upload avatar ===
server.post("/upload-avatar", upload.single("avatar"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Use json-server router as fallback
server.use(router);

// === Локальный запуск ===
if (process.env.NODE_ENV !== "production") {
  server.listen(8000, () => {
    console.log("Server running on http://localhost:8000");
  });
}

// === Экспорт для Vercel ===
module.exports = server;
