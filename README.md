# Misinfo Research Platform

Full-stack web application for social media misinformation research. Implements a 2×2 experimental design (style: manipulative A vs neutral B) × (metrics: high vs low social proof).

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS
- **Export:** ExcelJS (.xlsx)
- **Auth:** JWT-based admin login

---

## Run your own instance

The platform is self-hosted: you run your own copy and become its administrator.
Nothing is shared with anyone else — each instance has its own database and its
own accounts.

### 1. Get the code

```bash
git clone https://github.com/lowcydizajnu/missinfo-research.git
cd missinfo-research
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set at least these two:

- **`JWT_SECRET`** — a long random string (required; the server refuses to start
  without it). Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- **`ADMIN_PASSWORD`** — the password for your first admin account.

`ANTHROPIC_API_KEY` is optional (enables AI-assisted translation). Never commit `.env`.

### 3. Start

```bash
npm start          # or:  npm run dev   (auto-reload during development)
```

On first run the server creates the database and seeds an **`admin`** account from
your `ADMIN_PASSWORD`. Open **http://localhost:3000/admin.html** and log in:

- **Login:** `admin`
- **Password:** your `ADMIN_PASSWORD`

You are now the administrator of your own instance. From the **👥 Konta** tab you
can create more accounts:

- **admin** — full access; manages every study and all accounts
- **researcher** — sees and manages only their own studies

Create a study with **+ Nowe**, add posts, and share its participant link
(`/study/<slug>`). Participants take part anonymously — no login required.

> **Deploying to a server?** It's a single Node process and runs anywhere Node 18+
> and a writable disk are available (Railway, Render, a VPS, Docker…). Set the same
> environment variables in your host's config; the Railway walkthrough below is one
> example. Full technical docs are served at `/docs.html`.

---

## Run with Docker

If you'd rather not install Node locally:

```bash
cp .env.example .env      # set JWT_SECRET + ADMIN_PASSWORD
docker compose up -d
```

Then open **http://localhost:3000/admin.html** and log in as `admin`. The database
and uploaded images persist in named volumes (`misinfo-data`, `misinfo-uploads`)
across container rebuilds.

---

## Railway Deployment

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/lowcydizajnu/missinfo-research)

> After clicking, set **`JWT_SECRET`** and **`ADMIN_PASSWORD`** in the Railway
> project's **Variables**, then add a persistent volume mounted at `/app/data`
> (and optionally `/app/uploads`). The step-by-step guide below covers this in detail.

### Step-by-step

1. **Push code to GitHub** — create a new repository and push all files.

2. **Create Railway project**
   - Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
   - Select your repository

3. **Set environment variables** in Railway dashboard → Variables:
   ```
   ADMIN_PASSWORD=your-secure-password
   JWT_SECRET=your-long-random-secret
   NODE_ENV=production
   ```

4. **Add persistent volume for database**
   - Railway dashboard → your service → **Volumes** → **Add Volume**
   - Mount path: `/app/data`
   - This persists the SQLite database across deployments

5. **Add persistent volume for uploads**
   - Add another Volume, mount path: `/app/uploads`
   - This persists post images across deployments

6. **Deploy** — Railway auto-detects Node.js via `package.json` and deploys automatically.

7. **Access admin panel:**
   ```
   https://yourapp.railway.app/admin
   ```

8. **Create your first study:**
   - Log in as user `admin` with your `ADMIN_PASSWORD`
   - Click **+ Nowe** to create an empty study
   - Fill in study name, institution, contact email
   - Add posts in the **Posty** tab (from scratch or from the shared post library)

9. **Share participant URL:**
   ```
   https://yourapp.railway.app/study/[slug]
   ```

10. **Run multiple parallel studies:**
    - Create multiple studies — each gets a unique `/study/[slug]` URL
    - All data is stored separately per study
    - Each study can be exported independently

---

## Participant Flow

| Screen | Description |
|--------|-------------|
| 1. Consent | Study info, data collection disclosure, agree/decline |
| 2. Instructions | How to use Like/Dislike/Share/Flag buttons |
| 3. Demographics | Age group, residence, education, gender |
| 4. Transition | Brief reminder before feed |
| 5. Feed | Scrollable posts, forced interaction, dwell tracking |
| 6. Transition | Brief notice before rating phase |
| 7. Rating | 1-7 Likert credibility scale per post (no metrics shown) |
| 8. Debrief | Study purpose explained, TRUE/FALSE labels revealed |

---

## 2×2 Experimental Design

| | Metrics HIGH | Metrics LOW |
|---|---|---|
| **Style A** (manipulative) | A-HIGH | A-LOW |
| **Style B** (neutral) | B-HIGH | B-LOW |

- **Style A:** Red left border on false posts, red headline color, manipulative wording
- **Style B:** False posts look identical to true posts (no visual distinction)
- **HIGH metrics:** Likes/shares shown in hundreds–thousands (accent blue)
- **LOW metrics:** Likes/shares shown as 1–20 (grey)

---

## Admin Panel Tabs

| Tab | Description |
|-----|-------------|
| 📊 Pulpit | Dashboard with session stats, 2×2 completion and belief tables |
| 📋 Badania | Create, edit settings, duplicate, delete studies |
| ✏️ Posty | Per-study post editor with image upload and reordering |
| 📥 Eksport | Download Excel with 4 data sheets |

---

## Excel Export (4 sheets)

| Sheet | Contents |
|-------|----------|
| `Dane_surowe` | One row per reaction — all raw data |
| `Oceny_wiarygodnosci` | One row per credibility rating |
| `Podsumowanie_sesji` | One row per completed session with aggregates |
| `Design_2x2` | Pivot table + demographic breakdown |

---

## File Structure

```
├── server.js              # Express server
├── .env                   # Environment variables
├── package.json
├── Procfile               # Railway start command
├── railway.json           # Railway config
├── db/
│   └── database.js        # SQLite schema + default posts seeder
├── routes/
│   ├── participant.js     # Participant API endpoints
│   ├── admin.js           # Admin API + auth middleware
│   └── export.js          # Excel generation logic
├── public/
│   ├── index.html         # Participant SPA
│   ├── admin.html         # Admin panel
│   ├── css/
│   │   ├── participant.css
│   │   └── admin.css
│   └── js/
│       ├── participant.js
│       └── admin.js
├── data/                  # SQLite database (auto-created)
└── uploads/               # Post images (auto-created)
```

---

## API Reference

### Participant (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/session/start` | Start session, get posts + condition assignment |
| `POST` | `/api/session/consent` | Record consent |
| `POST` | `/api/session/demographics` | Save demographic data |
| `POST` | `/api/reaction` | Record post reaction |
| `POST` | `/api/rating` | Record credibility rating |
| `POST` | `/api/session/complete` | Complete session, get debrief data |

### Admin (Bearer JWT required)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/login` | Get JWT token |
| `GET` | `/api/admin/studies` | List all studies |
| `POST` | `/api/admin/studies` | Create study + seed default posts |
| `PATCH` | `/api/admin/studies/:id` | Update study settings |
| `DELETE` | `/api/admin/studies/:id` | Delete study + all data |
| `POST` | `/api/admin/studies/:id/duplicate` | Duplicate study + posts |
| `GET` | `/api/admin/studies/:id/posts` | List posts for study |
| `POST` | `/api/admin/posts` | Add new post |
| `PATCH` | `/api/admin/posts/:id` | Update post |
| `PATCH` | `/api/admin/posts/:id/reorder` | Move post up/down |
| `POST` | `/api/admin/posts/:id/image` | Upload post image |
| `DELETE` | `/api/admin/posts/:id/image` | Remove post image |
| `GET` | `/api/admin/dashboard/:studyId` | Dashboard stats |
| `GET` | `/api/admin/export/:studyId` | Download Excel file |

## Konfiguracja MS Clarity (osobny projekt per badanie)

1. Dla każdego badania utwórz osobny projekt na clarity.microsoft.com
2. Skopiuj Project ID z URL dashboardu danego projektu
3. W panelu admina otwórz ustawienia badania, włącz przełącznik
   MS Clarity i wklej Project ID
4. Nagrania tego badania trafią do dedykowanego projektu Clarity

### Maskowanie danych

- Formularz demograficzny (wiek, płeć, wykształcenie, miejsce zamieszkania)
  jest maskowany atrybutem `data-clarity-mask="true"` — dane osobowe nie
  trafiają do nagrań Clarity.
- Treść postów (nagłówek, treść, źródło) oraz przyciski skali Likert (1–7)
  mają atrybut `data-clarity-unmask="true"` — badacze widzą w nagraniach
  który post uczestnik oglądał i jaką ocenę wybrał.

> **Jeśli liczby na skali nadal są zamaskowane:** sprawdź w panelu Clarity
> Settings → Masking i ustaw tryb **"Balanced"** lub
> **"Mask only form fields"** zamiast **"Mask all text"** — ustawienie
> na poziomie projektu może nadpisywać atrybuty elementów.

### Heatmapy per ekran / per post

Aplikacja to SPA — wszystkie ekrany działają pod jednym URL, przez co Clarity
domyślnie nakłada kliknięcia ze wszystkich ekranów na jeden heatmap.
Aby temu zaradzić, przy każdej zmianie ekranu ustawiane są:
- custom tag `screen` (np. `post_3_id5`, `consent`, `demographics`)
- wirtualny URL w historii przeglądarki (hash, np. `#post_3_id5`)

**Jak filtrować heatmapy w Clarity:**
w panelu Clarity filtruj nagrania i heatmapy po custom tagu `screen`
(np. `screen = post_3_id5`) albo wybierz odpowiedni wirtualny adres URL
z listy stron, aby zobaczyć heatmapę pojedynczego ekranu lub posta
zamiast nałożonych klików ze wszystkich ekranów.

---

## Accounts

The admin panel is multi-user and **invite-only** — there is no public sign-up.
On first boot the server creates one `admin` account from `ADMIN_PASSWORD` and
assigns all existing studies to it. From the **👥 Konta** tab an admin can create
further accounts:

- **admin** — sees and manages every study, and manages accounts.
- **researcher** — sees and manages only their own studies.

Passwords are stored as bcrypt hashes; the server requires `JWT_SECRET` to start
and rate-limits the login endpoint. Every study endpoint is ownership-checked
server-side, so one researcher can never reach another's studies or data.

## Documentation

A standalone technical reference (architecture, data model, API, deployment,
translations) is served at **`/docs.html`** and lives at
[`public/docs.html`](public/docs.html).

## License

Released under the [MIT License](LICENSE) © 2026 Paweł Rosner.

Optional AI-assisted translation uses the Anthropic API via the official SDK and
is enabled only when `ANTHROPIC_API_KEY` is set; the platform is fully functional
without it.
