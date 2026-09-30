import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("grading/index", { pageTitle: "Grading", activeTab: "grades" });
});

export default router;
