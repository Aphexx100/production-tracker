# Production Tracker

A small web app for tracking a film production: daily call summaries and a shot list.

- **Daily summaries**: a rich text editor for the notes from each daily call. You can paste screenshots straight in. A list on the left shows every day; click a day to open its summary. The editor saves automatically.
- **Shot tracker**: a spreadsheet-style grid with shot name, description (with images), lens, comments and per-person to-dos. It also has Shotgrid-style extras: status pipeline, frame in/out with length and timecode, handles, sequence and scene, shot size, camera and movement, location, INT/EXT, day/night, shoot day, assignee, priority and due date.
- **References**: one container per sequence (the same codes as the "Seq" column), with files sorted into Movies, Pictures, PDFs, Links, Audio, Documents, 3D & scenes and Other. Drag files or links from your desktop or browser onto a sequence to upload them. Movies and pictures get thumbnails and open in a viewer; PDFs open in a new tab. The paperclip next to each Seq in the shot tracker jumps to its references, and "Shots" on a sequence filters the shot tracker to it.
- **Timeline**: a Gantt chart with one row per sequence that opens into its shots. Drag bars to move them, drag their ends to change dates, or drag across an empty row to plan it. Milestones (◆) and deadlines (⚑) can belong to the whole project, a sequence or a single shot; overdue deadlines turn red and the next ones show at the top. Shoot days and shot due dates appear as markers. Zoom by days, weeks or months.
- **Tasks**: a task list per team member. Create tasks with **New task** (or press N) or the quick field at the top of a column. Every field is edited right on the card: text, priority (urgent / high / normal / low), due date, person, milestone and shot. Sort by priority, due date or newest. Tasks link to shots, to the call they came from, and to milestones. **Convert to task list** on a daily summary lets Claude read the call and propose every action item (person, due date, shot, milestone); you review and fix them before anything is created. **Convert to milestones** turns the milestones that tasks mention into deadlines on the Timeline and links the tasks; if a milestone already exists, it asks whether to override it, add a new one, or leave it.
- **To-dos** for Mihai, Miguel, Rafael, Micael and Sascha. Add them per shot, or add general ones on the "To-dos by person" board. An admin can change the team.

Try the interface without any setup: run it locally (see below) and open `/?demo`. Demo data stays in your own browser only.

## Features

| Area | What you get |
| --- | --- |
| Editor | Headings, font size, bold, italic, underline, strike, inline code, text color, highlight, bullet, numbered and check lists, alignment, quotes, dividers, tables, links, images (paste, drop or upload), undo and redo, clear formatting, print or save as PDF |
| Grid | Click to select, type to edit, Enter/Tab/arrow keys, Delete clears, Ctrl+C copies, Ctrl+V pastes (including whole blocks copied from Excel or Google Sheets), Ctrl+D duplicates |
| Rows | Add (auto-numbers `SQ010_0010`, then `_0020`), insert below, duplicate, delete, drag to reorder |
| Sequences | Rename (updates shots, references and milestones at once; renaming onto an existing name merges), add a title, delete (shots are kept and moved) — More › Manage sequences, or “Edit sequence” on a group header |
| View | Sort by any column, filter by status and assignee, search, hide omitted, group by sequence, show or hide and resize columns, Status and Shot columns stay pinned while you scroll |
| Totals | Shot count, total length in frames and timecode at the project frame rate, status breakdown |
| Data | CSV export of the current view, CSV import that matches column headers |
| Team | Live updates: changes from other people appear without a reload |

## Security model

- The code in this repository is public. The **data is not**: it lives in a private Supabase (Postgres) database.
- Supabase Auth handles passwords. It stores bcrypt hashes only, never the passwords. The app requires at least 10 characters and rejects common passwords.
- Anyone can register, but a new account sees **nothing**. An admin must approve it first, and the email address must be confirmed.
- Row-level security on every table enforces this in the database itself, so the rule also holds for someone who calls the API directly. The `anon` role has no table access at all.
- Images and reference files go to private storage buckets. The app shows them through signed URLs that expire. Only the uploader or an admin can delete a reference.
- Stored rich text is sanitized with DOMPurify before display. A strict Content-Security-Policy blocks inline and third-party scripts.
- `tests/schema.test.mjs` runs the real schema in an in-process Postgres and checks these rules as different users.

The Supabase URL and the anon (publishable) key are built into the public site. That is how Supabase is designed to work: the key only identifies the project, and row-level security does the protection. **Never** put the `service_role` or secret key anywhere in this repository.

## Setup (one time, about 15 minutes)

### 1. Create the Supabase project

1. Create a free account at [supabase.com](https://supabase.com) and create a new project. Pick a region close to the team and save the database password somewhere safe.
2. Open **SQL Editor > New query**. Paste the full contents of [`supabase/schema.sql`](supabase/schema.sql).
3. In the pasted SQL, replace `ADMIN_EMAIL_HERE` with the email address of the first admin. Then click **Run**.
4. Open a new query, paste the contents of [`supabase/002_references.sql`](supabase/002_references.sql) and click **Run**. This adds the References tab.

5. Open a new query, paste [`supabase/003_upload_limit.sql`](supabase/003_upload_limit.sql) and click **Run**. This adds the upload size setting.

6. Open a new query, paste [`supabase/004_timeline.sql`](supabase/004_timeline.sql) and click **Run**. This adds the Timeline.

7. Open a new query, paste [`supabase/005_tasks.sql`](supabase/005_tasks.sql) and click **Run**. This adds the Tasks tab.

8. Open a new query, paste [`supabase/006_task_priority.sql`](supabase/006_task_priority.sql) and click **Run**. This adds task priorities.

9. Open a new query, paste [`supabase/007_sequence_admin.sql`](supabase/007_sequence_admin.sql) and click **Run**. This lets you rename and delete sequences.

Existing projects only need the numbered files they have not run yet. Every file is safe to run again.

**Upload size:** Supabase limits the size of each uploaded file for the whole project (50 MB on the free plan). To allow bigger movies, raise it under **Storage > Settings** (paid plans allow up to 500 GB per file), then set the same number in the app under **Admin > Upload limit**. The app refuses larger files before uploading and offers to add them as a link instead.

### AI task extraction (optional)

"Convert to task list" sends the text of one daily summary to Claude (`claude-opus-5`) through a Supabase Edge Function, so the Anthropic API key never reaches the browser or this repository. Only approved users can call it, and it only reads data they can already see. Nothing is saved until a person reviews the proposed tasks.

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) (Settings > API Keys). Usage is billed to that account; one call summary costs a few cents.
2. In Supabase, open **Edge Functions > Secrets** and add `ANTHROPIC_API_KEY` with the key.
3. Open **Edge Functions > Deploy a new function > Via Editor**. Name it exactly `extract-tasks`, replace the sample code with the contents of [`supabase/functions/extract-tasks/index.ts`](supabase/functions/extract-tasks/index.ts), and click **Deploy**. Keep "Verify JWT" switched on.

With the Supabase CLI you can instead run `supabase functions deploy extract-tasks` from this folder. Without the function, the button explains that AI extraction is not set up; everything else works.

### 2. Configure authentication

In **Authentication**:

1. **Sign In / Providers > Email**: keep email signup enabled and **Confirm email** turned on. Set the minimum password length to 10. If your plan offers it, also turn on leaked password protection.
2. **URL Configuration**: set **Site URL** to `https://aphexx100.github.io/production-tracker/`. Add the same address under **Redirect URLs**.

### 3. Connect the GitHub site

1. In Supabase, copy the **Project URL** (**Project Settings > Data API**, or `https://<project-id>.supabase.co` where the id is in the dashboard address) and the **anon** or **publishable** key (**Project Settings > API Keys**).
2. In this GitHub repository, open **Settings > Secrets and variables > Actions > Variables**. Add these two repository variables:
   - `SUPABASE_URL`: the project URL
   - `SUPABASE_ANON_KEY`: the anon or publishable key
3. Open **Actions**, select **Deploy to GitHub Pages**, and click **Run workflow**. Pushes to `main` also deploy.

### 4. First sign-in

1. Open the site and register with the admin email from step 1. Confirm the email.
2. When other people register, the **Admin** button shows a red badge. Open it and approve only people you know.

In the Admin window you can also set the project name and frame rate, and add or remove team members for the to-do lists.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?demo` for the demo. To work against the real project, copy `.env.example` to `.env.local` and fill in both values.

```bash
npm run check
```

`npm run check` builds the site and runs three test suites: the schema and security rules on PGlite, the Edge Function with mocked Supabase and Claude clients, and an end-to-end browser test with Playwright. Run `npx playwright install chromium` once before the first run.

## Project layout

```
supabase/schema.sql   tables, row-level security, storage bucket, realtime
supabase/002_references.sql   sequences + references tables, "references" bucket
supabase/003_upload_limit.sql upload size setting
supabase/004_timeline.sql     dates on sequences and shots, milestones and deadlines
supabase/005_tasks.sql        task due dates, milestone and call links
supabase/006_task_priority.sql task priority
supabase/007_sequence_admin.sql rename / delete sequences everywhere at once
supabase/functions/extract-tasks/index.ts   Edge Function: Claude reads a call summary
src/main.js           boot, sign-in gate, tabs
src/auth.js           sign in, register, password reset, approval screen
src/dailies.js        daily summaries: day list and editor
src/editor.js         rich text editor (TipTap) and toolbar
src/shots.js          shot tracker grid
src/todos.js          to-do popover and per-person board
src/references.js     references per sequence: drag & drop upload, viewer
src/timeline.js       timeline: sequences, shots, milestones, deadlines
src/tasks.js          tasks per person, convert to milestones
src/extract.js        "Convert to task list" review dialog
src/admin.js          users, project settings, team
src/api/supabase.js   data access (Supabase)
src/api/demo.js       browser-only stand-in used by ?demo and the tests
```
