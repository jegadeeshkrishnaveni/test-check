import app from '../server.js';

export default function handler(req, res) {
  // Ensure res is ended to prevent hanging
  return new Promise((resolve) => {
    const originalEnd = res.end.bind(res);
    res.end = function(...args) {
      resolve();
      return originalEnd(...args);
    };
    
    app(req, res);
  });
}
