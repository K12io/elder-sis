import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("attendance/index", { pageTitle: "Attendance", activeTab: "attend" });
});

export default router;
