const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Body parser for JSON and form data (allotment check API, forms, etc.)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
const indexRouter = require('./routes/index');
app.use('/', indexRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).render('404', { message: `The requested URL '${req.originalUrl}' was not found.` });
});

// 500 — error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', {
    message: "Couldn't reach the live IPO data source right now. Please try again in a moment.",
  });
});

if (!process.env.VERCEL) {
  // Warm the IPO snapshot so the first visitor doesn't wait on upstream APIs
  require('./data/ipoService').refreshIpos();
  app.listen(PORT, () => {
    console.log(`\n🚀 IPO Dashboard running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
