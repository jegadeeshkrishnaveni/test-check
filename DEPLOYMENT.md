# Deployment Guide - Vercel

## Prerequisites
- GitHub account with this repository pushed
- Vercel account (free tier at vercel.com)
- Environment variables configured

## Step 1: Prepare Environment Variables

Before deploying, create a `.env` file locally (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` and add your actual values:
- `ADMIN_PASSWORD` - Password for admin dashboard
- `STUDENT_PASSWORD` - Shared password for students
- `GITHUB_TOKEN` - (Optional) For GitHub sync features
- `GITHUB_OWNER` - (Optional) Your GitHub username
- `GITHUB_REPO` - (Optional) Repository name

**IMPORTANT**: Never commit `.env` to GitHub. It's already in `.gitignore`.

## Step 2: Commit and Push to GitHub

```bash
git add .
git commit -m "chore: prepare for Vercel deployment"
git push origin main
```

Verify these files are committed:
- ✅ `api/index.js` - Serverless handler
- ✅ `server.js` - Express app
- ✅ `vercel.json` - Deployment configuration
- ✅ `package.json` - Dependencies
- ✅ `index.html` - Frontend
- ✅ `admin.html` - Admin dashboard
- ✅ `.gitignore` - Excludes unnecessary files

Verify these are NOT committed:
- ✅ `.env` - Local environment variables
- ✅ `node_modules/` - Dependencies (rebuilt on Vercel)
- ✅ `.git/` - Git history

## Step 3: Deploy to Vercel

### Option A: Using Vercel Dashboard (Recommended)

1. Go to [vercel.com](https://vercel.com)
2. Sign in with GitHub
3. Click "New Project"
4. Select this repository
5. Click "Import"
6. In Environment Variables section, add:
   - `ADMIN_PASSWORD` = your_admin_password
   - `STUDENT_PASSWORD` = your_student_password
   - `GITHUB_TOKEN` = (if needed)
   - `GITHUB_OWNER` = (if needed)
   - `GITHUB_REPO` = (if needed)
7. Click "Deploy"

### Option B: Using Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Add environment variables when prompted
# Follow the interactive setup
```

## Step 4: Verify Deployment

After deployment completes:

1. **Test Frontend**
   ```
   https://your-deployment.vercel.app/
   ```
   Should show the student login page

2. **Test Admin Dashboard**
   ```
   https://your-deployment.vercel.app/admin.html
   ```
   Should show admin login page

3. **Test API**
   ```
   https://your-deployment.vercel.app/api/questions
   ```
   Should return JSON with questions

## Troubleshooting

### Error: "FUNCTION_INVOCATION_FAILED"

**Cause**: Serverless function handler issue

**Solution**:
- Verify `api/index.js` exports a proper handler
- Check that `server.js` exports the Express app
- Ensure all dependencies are in `package.json`

### Error: "Cannot find module 'express'"

**Cause**: Dependencies not installed

**Solution**:
- Vercel should install automatically
- Check `package.json` has express dependency
- Redeploy by pushing to GitHub

### 500 Error on Routes

**Cause**: Missing environment variables

**Solution**:
- Add all required env vars in Vercel project settings
- Redeploy after adding variables
- Check Vercel Function logs

## View Logs

In Vercel Dashboard:
1. Select your project
2. Go to "Deployments" tab
3. Click the latest deployment
4. Click "Function Logs" to see API errors
5. Click "Runtime Logs" for deployment errors

## Local Testing

Before deploying, test locally:

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Should start on http://localhost:3000
```

## Important Notes

- Vercel's serverless functions have a 30-second timeout (configured in `vercel.json`)
- File system writes are temporary and stored in `/tmp` on Vercel
- Environment variables are NOT included in git, only in Vercel dashboard
- Always set environment variables in Vercel before the first deployment

## Re-deployment

To redeploy after code changes:

```bash
git add .
git commit -m "your commit message"
git push origin main
```

Vercel will automatically rebuild and redeploy!

## Still Having Issues?

1. Check Vercel Function Logs (see "View Logs" section above)
2. Ensure all environment variables are set
3. Verify `.env` is NOT committed to GitHub
4. Check that all API routes match your frontend calls
5. Test locally first with `npm run dev`
