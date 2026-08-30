import('fs').then(fs => {
  if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
  }
  const filesToCopy = ['index.html', 'admin.html', 'code-runner.js', 'questions.json', 'tests_store.json'];
  for (const f of filesToCopy) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, `public/${f}`);
    }
  }
  if (fs.existsSync('vendor')) {
    fs.cpSync('vendor', 'public/vendor', { recursive: true });
  }
  console.log('Build complete: all static assets prepared in public/');
});
