// cleanupOldBackups.js
const supabase = require("./db");
const dayjs = require("dayjs");

module.exports = async function cleanupOldBackups() {
  try {
    const { data, error } = await supabase.storage
      .from("mlbackups")
      .list("", { limit: 1000 });

    if (error) {
      console.error("❌ List error:", error.message);
      return { success: false };
    }

    const now = dayjs();
    const filesToDelete = [];

    data.forEach((file) => {
      if (!file.created_at) return;

      const fileDate = dayjs(file.created_at);
      const diffDays = now.diff(fileDate, "day");

      // 🔥 60 days old
      if (diffDays > 60) {
        filesToDelete.push(file.name);
      }
    });

    if (filesToDelete.length === 0) {
      console.log("✅ No old backups to delete");
      return { success: true, deleted: 0 };
    }

    const { error: delError } = await supabase.storage
      .from("mlbackups")
      .remove(filesToDelete);

    if (delError) {
      console.error("❌ Delete error:", delError.message);
      return { success: false };
    }

    console.log(`🗑️ Deleted ${filesToDelete.length} old backups`);
    return { success: true, deleted: filesToDelete.length };

  } catch (err) {
    console.error("❌ Cleanup failed:", err.message);
    return { success: false };
  }
};
