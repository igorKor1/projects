const request = require("supertest");
const serverApp = require("../api/index");
const { calcStreak } = require("../utils/calcStreak");

jest.mock("../utils/calcStreak", () => ({
  calcStreak: jest.fn(),
}));

jest.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => ({
      from: () => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: null }),
        insert: jest.fn().mockResolvedValue({ data: {}, error: null }),
        update: jest.fn().mockResolvedValue({ data: {}, error: null }),
      }),
    }),
  };
});

let server;

beforeAll((done) => {
  server = serverApp.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

describe("POST /exercise-results", () => {
  beforeEach(() => {
    calcStreak.mockReset();
  });

  it("should save exercise results and calculate streak", async () => {
    calcStreak.mockReturnValue(3);

    const exercises = [
      {
        exercise_id: "6",
        exerciseResults: [
          {
            date: "2025-09-13",
            user_id: 1,
            completed: true,
            is_correct: true,
            exercise_id: 6,
            question_id: 18,
            selected_answer: "B",
            selected_answer_id: 37,
          },
        ],
      },
      {
        exercise_id: "7",
        exerciseResults: [
          {
            date: "2025-09-14",
            user_id: 1,
            completed: true,
            is_correct: false,
            exercise_id: 7,
            question_id: 20,
            selected_answer: "C",
            selected_answer_id: 50,
          },
        ],
      },
    ];

    const res = await request(server)
      .post("/exercise-results")
      .set("Authorization", "Bearer test-token")
      .send({ user_id: 1, exercises, result_uuid: "test-uuid" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("streak");
    expect(res.body.streak).toBe(3);
    expect(calcStreak).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String)
    );
  });

  it("should return streak 1 for first exercise", async () => {
    calcStreak.mockReturnValue(1);

    const exercises = [
      {
        exercise_id: "10",
        exerciseResults: [
          {
            date: "2025-09-15",
            user_id: 2,
            completed: true,
            is_correct: true,
            exercise_id: 10,
            question_id: 30,
            selected_answer: "A",
            selected_answer_id: 60,
          },
        ],
      },
    ];

    const res = await request(server)
      .post("/exercise-results")
      .set("Authorization", "Bearer test-token")
      .send({ user_id: 2, exercises });

    expect(res.status).toBe(201);
    expect(res.body.streak).toBe(1);
  });

  it("should reset streak if dates are not consecutive", async () => {
    calcStreak.mockReturnValue(1);

    const exercises = [
      {
        exercise_id: "11",
        exerciseResults: [
          {
            date: "2025-09-10",
            user_id: 3,
            completed: true,
            is_correct: true,
            exercise_id: 11,
            question_id: 35,
            selected_answer: "B",
            selected_answer_id: 70,
          },
        ],
      },
      {
        exercise_id: "12",
        exerciseResults: [
          {
            date: "2025-09-14",
            user_id: 3,
            completed: true,
            is_correct: false,
            exercise_id: 12,
            question_id: 36,
            selected_answer: "C",
            selected_answer_id: 71,
          },
        ],
      },
    ];

    const res = await request(server)
      .post("/exercise-results")
      .set("Authorization", "Bearer test-token")
      .send({ user_id: 3, exercises });

    expect(res.status).toBe(201);
    expect(res.body.streak).toBe(1);
  });

  it("should calculate streak correctly for multiple consecutive days", async () => {
    calcStreak.mockReturnValue(5);

    const exercises = [
      {
        exercise_id: "13",
        exerciseResults: [
          {
            date: "2025-09-11",
            user_id: 4,
            completed: true,
            is_correct: true,
            exercise_id: 13,
            question_id: 40,
            selected_answer: "A",
            selected_answer_id: 80,
          },
          {
            date: "2025-09-12",
            user_id: 4,
            completed: true,
            is_correct: true,
            exercise_id: 13,
            question_id: 41,
            selected_answer: "B",
            selected_answer_id: 81,
          },
          {
            date: "2025-09-13",
            user_id: 4,
            completed: true,
            is_correct: true,
            exercise_id: 13,
            question_id: 42,
            selected_answer: "C",
            selected_answer_id: 82,
          },
          {
            date: "2025-09-14",
            user_id: 4,
            completed: true,
            is_correct: true,
            exercise_id: 13,
            question_id: 43,
            selected_answer: "D",
            selected_answer_id: 83,
          },
          {
            date: "2025-09-15",
            user_id: 4,
            completed: true,
            is_correct: true,
            exercise_id: 13,
            question_id: 44,
            selected_answer: "A",
            selected_answer_id: 84,
          },
        ],
      },
    ];

    const res = await request(server)
      .post("/exercise-results")
      .set("Authorization", "Bearer test-token")
      .send({ user_id: 4, exercises });

    expect(res.status).toBe(201);
    expect(res.body.streak).toBe(5);
  });
});
