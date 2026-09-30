import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("grades/index", { pageTitle: "Grades & Transcripts", activeTab: "transcripts" });
});

export default router;
