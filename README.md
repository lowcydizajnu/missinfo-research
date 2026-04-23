# MissInfo Research Platform

Full-stack web application for social media misinformation research. Implements a 2×2 experimental design (style: manipulative A vs neutral B) × (metrics: high vs low social proof).

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS
- **Export:** ExcelJS (.xlsx)
- **Auth:** JWT-based admin login

---

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Edit `.env`:

```
ADMIN_PASSWORD=your-secure-password
JWT_SECRET=your-long-random-secret
PORT=3000
DATABASE_PATH=./data/research.db
UPLOADS_PATH=./uploads
```

### 3. Start the server

```bash
npm start
```

Visit:
- Admin panel: http://localhost:3000/admin
- Participant URL (after creating a study): http://localhost:3000/study/[slug]

---

## Railway Deployment

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
   - Log in with your `ADMIN_PASSWORD`
   - Go to **Badania** tab → **Nowe badanie**
   - Fill in study name, institution, contact email
   - 10 default posts are auto-seeded
   - Edit posts in **Edytor Postów** tab

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
