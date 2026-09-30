import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.render("students/index", { pageTitle: "Student Records", activeTab: "students" });
});

router.get("/search", (req, res) => {
  res.render("students/search", {
    pageTitle: "Student Search",
    activeTab: "students",
    q: typeof req.query.q === "string" ? req.query.q : "",
  });
});

export default router;
