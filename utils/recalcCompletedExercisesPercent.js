async function recalcCompletedExercisesPercent(user_id, supabase) {
  console.log("Recalculating completed exercises percent for user:", user_id);

  // Получаем все результаты пользователя
  const { data: results } = await supabase
    .from("exercise_results")
    .select("exercises")
    .eq("user_id", user_id);

  if (!results) {
    console.log("No exercise results found for user.");
    return { completedCount: 0, percent: 0 };
  }

  let completedCount = 0;

  for (const res of results) {
    const exArr = Array.isArray(res.exercises)
      ? res.exercises
      : JSON.parse(res.exercises);
    console.log("Processing exercise array:", exArr);

    for (const ex of exArr) {
      console.log("Processing exercise_id:", ex.exercise_id);

      // Получаем количество вопросов из таблицы questions для exercise_id
      const { data: questionsData, error: questionsError } = await supabase
        .from("questions")
        .select("id")
        .eq("exercise_id", ex.exercise_id);

      if (questionsError) {
        console.error(
          "Error fetching questions for exercise_id",
          ex.exercise_id,
          questionsError.message
        );
        continue;
      }

      const totalQuestions = questionsData?.length || 0;
      console.log(
        `Exercise ${ex.exercise_id} has ${totalQuestions} questions, user answered ${ex.exerciseResults.length}`
      );

      if (totalQuestions > 0 && ex.exerciseResults.length >= totalQuestions) {
        completedCount++;
        console.log(`Exercise ${ex.exercise_id} marked as completed`);
      }
    }
  }

  // Общее количество упражнений
  const { data: exercisesData } = await supabase.from("exercises").select("id");
  const totalExercises = exercisesData?.length || 0;
  console.log("Total exercises in system:", totalExercises);

  const percent =
    totalExercises > 0 ? (completedCount / totalExercises) * 100 : 0;
  console.log(
    `User ${user_id} completed ${completedCount} exercises, percent: ${percent.toFixed(
      2
    )}%`
  );

  // Обновляем пользователя
  const { error: updateError } = await supabase
    .from("users")
    .update({
      completedExerciseAmount: completedCount,
      completed_exercises_percent: percent,
    })
    .eq("id", user_id);

  if (updateError) {
    console.error("Error updating user progress:", updateError.message);
  } else {
    console.log("User progress updated successfully");
  }

  return { completedCount, percent };
}

module.exports = { recalcCompletedExercisesPercent };
