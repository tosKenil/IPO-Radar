const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
const indexRouter = require('./routes/index');
app.use('/', indexRouter);

// 404
app.use((req, res) => {
  res.status(404).render('404', { message: 'Page Not Found' });
});

// 500 — most commonly a failed live-data fetch (NSE/Yahoo unreachable)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', {
    message: "Couldn't reach the live IPO data source right now. Please try again in a moment.",
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 IPO Dashboard running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
