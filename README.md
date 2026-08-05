# Sudoku Trainer

A Sudoku trainer that reads live pencil-mark notes and surfaces strategy
hints (Naked/Hidden Singles, Pointing Pairs, Box-Line Reduction, Naked
Pairs/Triples, X-Wing, XY-Wing, Simple Colouring, Swordfish, Jellyfish),
with a seeded puzzle generator, dark mode, and a timed mode.

## Run locally
```
npm install
npm run dev
```

## Deploying to GitHub Pages (already set up)

This repo has a GitHub Actions workflow (`.github/workflows/deploy.yml`)
that automatically builds and deploys on every push to `main`. Setup:

1. **Create the repo on GitHub** named `sudoku-trainer` (or pick your own
   name — see the note below if you do).
2. **Push this project to it:**
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/jeducation/sudoku-trainer.git
   git push -u origin main
   ```
3. **Turn on Pages:** on GitHub, go to the repo's **Settings → Pages**, and
   under "Build and deployment", set **Source** to **GitHub Actions**
   (not "Deploy from a branch" — the workflow handles that itself).
4. Push (step 2's push already triggers it) — check the **Actions** tab
   for progress. Once it's green, your site is live at:
   ```
   https://jeducation.github.io/sudoku-trainer/
   ```
   Any future `git push` to `main` redeploys automatically — no manual
   build/upload step ever again.

**If you name the repo something other than `sudoku-trainer`:** edit the
`base` value in `vite.config.js` to match (`base: "/your-repo-name/"`),
commit, and push — the next Actions run will pick it up. If instead
you're using a personal `jeducation.github.io` repo (served at the
root), change it to `base: "/"`.

## Run the build manually (not required, the Action does this for you)
```
npm install
npm run build
```
Produces `dist/` — a fully static site, no server or database required.

---

## Getting it onto iOS

### Option A — Add to Home Screen (PWA), no App Store, no Mac needed
Already configured (manifest, icons, iOS meta tags, safe-area padding).
Once deployed to GitHub Pages: open the URL in **Safari** on the iPhone
(must be Safari, not Chrome), Share → **Add to Home Screen**. Launches
full-screen with its own icon, no App Store needed.

### Option B — Real App Store app, via Capacitor
Requires a Mac with Xcode, and an Apple Developer account ($99/year) once
you're ready to publish. From this project folder, on your Mac:
```
npm install
npm run build
npm install @capacitor/core @capacitor/ios
npx cap init "Sudoku Trainer" "com.yourname.sudokutrainer" --web-dir=dist
npx cap add ios
npx cap sync
npx cap open ios
```
That opens Xcode, where you can run it in the Simulator or on your own
device immediately, or submit to TestFlight/App Store with a paid account.
