import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("scheduling/index", { pageTitle: "Scheduling", activeTab: "schedule" });
});

export default router;
