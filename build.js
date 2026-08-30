import('fs').then(fs => {
  if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
  }
  fs.copyFileSync('index.html', 'public/index.html');
  fs.copyFileSync('admin.html', 'public/admin.html');
  if (fs.existsSync('vendor')) {
    fs.cpSync('vendor', 'public/vendor', { recursive: true });
  }
  console.log('Build complete: static assets prepared in public/');
});
