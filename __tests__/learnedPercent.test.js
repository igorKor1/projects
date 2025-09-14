const request = require("supertest");
const serverApp = require("../api/index");
const { recalcLearnedPercent } = require("../utils/recalcLearnedPercent");

jest.mock("../utils/recalcLearnedPercent", () => ({
  recalcLearnedPercent: jest.fn(),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: jest.fn().mockResolvedValue({ data: [], error: null }),
      eq: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(), // чтобы можно было делать .insert().select()
      update: jest.fn().mockReturnThis(), // чтобы можно было делать .update().eq()
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
}));

let server;

beforeAll((done) => {
  server = serverApp.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

describe("Words learning percent", () => {
  const token = "test-token"; // тестовый Bearer token

  it("should add new words and calculate 0% learned", async () => {
    const res = await request(server)
      .post("/words")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: 1, topic: "Animals", digit: 3 });

    expect(res.status).toBe(200);
    const items = res.body[0].items;
    expect(items.length).toBe(3);
    items.forEach((w) => expect(w.isLearned).toBe(false));
  });

  it("should update word to learned and recalc percent", async () => {
    const resUpdate = await request(server)
      .put("/words/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: 1, isLearned: true });

    expect(resUpdate.status).toBe(200);
    expect(resUpdate.body.isLearned).toBe(true);

    const percent = await recalcLearnedPercent(1);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it("should recalc percent when new words are added", async () => {
    const res = await request(server)
      .put("/words")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: 1, topic: "Animals", digit: 2 });

    expect(res.status).toBe(200);
    const newItems = res.body[0].items;
    expect(newItems.length).toBe(2);

    const percent = await recalcLearnedPercent(1);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it("should return 100% if all words are learned", async () => {
    // помечаем все слова как выученные
    await request(server)
      .put("/words/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: 1, isLearned: true });

    await request(server)
      .put("/words/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: 1, isLearned: true });

    const percent = await recalcLearnedPercent(1);
    expect(percent).toBe(100);
  });
});
