async function recalcLearnedPercent(user_id, supabase) {
  const { data: words, error } = await supabase
    .from("words")
    .select("id, isLearned")
    .eq("user_id", user_id);

  if (error) {
    console.error("Error calculating learned percent:", error.message);
    return 0;
  }

  if (!words || words.length === 0) return 0;

  const learnedCount = words.filter((w) => w.isLearned).length;
  const percent = Math.round((learnedCount / words.length) * 100);

  await supabase
    .from("users")
    .update({ learned_percent: percent })
    .eq("id", user_id);

  return percent;
}

module.exports = { recalcLearnedPercent };
