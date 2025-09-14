function calcStreak(
  updatedExercises,
  today = new Date().toISOString().split("T")[0]
) {
  const dates = [];
  for (let i = 0; i < updatedExercises.length; i++) {
    const ex = updatedExercises[i];
    for (let j = 0; j < ex.exerciseResults.length; j++) {
      const r = ex.exerciseResults[j];
      if (r.date && !dates.includes(r.date)) {
        dates.push(r.date);
      }
    }
  }

  dates.sort();
  let streak = 0;
  let currentDate = new Date(today);

  for (let i = dates.length - 1; i >= 0; i--) {
    const dateObj = new Date(dates[i]);
    const diffDays = Math.floor(
      (currentDate - dateObj) / (1000 * 60 * 60 * 24)
    );

    if (diffDays === 0 || diffDays === 1) {
      streak++;
      currentDate.setDate(currentDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

module.exports = { calcStreak };
