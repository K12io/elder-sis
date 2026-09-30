import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("reports/index", { pageTitle: "Reports", activeTab: "reports" });
});

export default router;
