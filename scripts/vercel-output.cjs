// Vercel "Other" preset needs a non-empty output directory. Only robots.txt goes in it, so no project file is ever
// served statically and every other path (including "/") is rewritten to the API function (vercel.json).
const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /\n');
console.log('vercel output: public/robots.txt');
