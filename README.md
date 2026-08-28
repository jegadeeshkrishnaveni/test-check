# Class Test Portal — setup

## What this does
- Students log in by typing their **own name + roll number**, plus **one shared test password** you announce at test time — no roster to pre-load.
- The first time a roll number logs in, that name gets locked in for it. If someone tries the same roll number with a different name later, they're blocked — this stops one student from opening another's in-progress test just by knowing their roll number.
- 100 MCQs + 15 coding programs (edit `questions.json` to add your real questions — a small template is in there now).
- **Autosave**: every answer (MCQ click, every code keystroke) is saved to the server within ~1 second, and again immediately if the tab closes or loses focus.
- **Resume**: if a student's tab crashes, closes by accident, or their internet drops, they log in again with the same name + roll number and land back exactly where they left off, all code intact. Nothing is ever cleared automatically — the only way a program's code gets wiped is the student clicking "Reset to starter code" and confirming it.
- **Auto-grading**: on Submit, each of the 15 programs runs against its test cases (via the free Piston execution service) and is scored automatically; MCQs score instantly. Every network call to Piston retries with increasing backoff (up to ~4 tries per test case) before giving up on that one test case — grading is deliberately slow rather than skipping anything.
- **Admin dashboard** (`admin.html`): live results table, search/sort, CSV export, and a **Regrade** button (per student or "Regrade all") in case the execution service was down or slow during someone's original submission.

## Quick Start - Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and set your passwords:
   ```
   ADMIN_PASSWORD=your_admin_password
   STUDENT_PASSWORD=your_student_password
   ```

4. Edit `questions.json`: add your real 100 MCQs and 15 programs, following the existing structure. Keep `id`s unique.

5. Start the server:
   ```bash
   npm run dev
   ```

6. Open in browser:
   - Student portal: http://localhost:3000/
   - Admin dashboard: http://localhost:3000/admin.html

## Deployment to Vercel

### Prerequisites
- Push this repository to GitHub
- Create a Vercel account (free at vercel.com)

### Steps

1. **Go to Vercel** and connect your GitHub repository
2. **Add Environment Variables** in Vercel project settings:
   - `ADMIN_PASSWORD` - Your admin password
   - `STUDENT_PASSWORD` - Shared password for students
   - Optional: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` for GitHub sync features
3. **Click Deploy** - Vercel will automatically build and deploy

For detailed deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)

## Before the real test: do one dry run

1. Open student portal in a private/incognito window
2. Log in as a test student
3. Answer a couple of questions
4. Close the tab WITHOUT submitting
5. Log in again with the same name + roll
6. Verify your answers are still there
7. Check admin dashboard and confirm student shows up as "in-progress"

## Architecture

- **Frontend**: Static HTML (`index.html`, `admin.html`)
- **Backend**: Express.js server (`server.js`)
- **API Handler**: Vercel serverless function (`api/index.js`)
- **Storage**: File-based (fallback to `/tmp` on Vercel)
- **Execution**: Piston API for code execution

## Things to know

- **Data Storage**: Files are stored locally in development, and in `/tmp` on Vercel (temporary). For persistent storage across deployments, consider adding a database.
- **Piston (the free execution API) is shared publicly.** With many students submitting close together, some test cases may need several retries — that's expected and handled automatically, it just makes Submit slower rather than less accurate. If a student's grading still looks off afterward (e.g. the service was down for their whole submission), use **Regrade** in admin.html to re-run their program's test cases without them needing to resubmit.
- The editor is a plain textarea — no syntax highlighting, no anti-cheat, no proctoring. Matches "keep it simple." Happy to add a proper code editor or anti-cheat measures as a follow-up.

## Project Structure

```
├── index.html              # Student login & test interface
├── admin.html              # Admin dashboard
├── server.js              # Express.js server
├── api/
│   └── index.js          # Vercel serverless handler
├── code-runner.js        # Code execution utility
├── questions.json        # Test questions (MCQs & programs)
├── tests_store.json      # Test metadata
├── package.json          # Dependencies
├── vercel.json          # Vercel configuration
├── .env.example         # Environment variables template
└── vendor/              # Third-party libraries (CodeMirror)
```

## Environment Variables

Create `.env` file with:
```
ADMIN_PASSWORD=your_password
STUDENT_PASSWORD=your_password
GITHUB_OWNER=optional_github_username
GITHUB_REPO=optional_repo_name
GITHUB_TOKEN=optional_github_token
```

**Never commit `.env` to Git** - it's already in `.gitignore`
