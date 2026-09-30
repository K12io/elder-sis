import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("admin/index", { pageTitle: "Administration", activeTab: "admin" });
});

export default router;
