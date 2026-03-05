# Concert Ticket Challenge (No Firebase)

You have one backend with 2 public pages:
- Player site: `/`
- Admin site: `/admin`

## Start server on your computer
From `C:\Users\Dante\OneDrive\Documents\codes`:

```powershell
npm install
$env:ADMIN_KEY="choose-a-secret-key"
$env:DAILY_TIMEZONE="Africa/Johannesburg"
npm start
```

Then open:
- [http://localhost:3000/](http://localhost:3000/)
- [http://localhost:3000/admin](http://localhost:3000/admin)

## Deploy publicly (anywhere access)
This repo now includes `render.yaml` for easy Render deploy.

1. Create a GitHub repo and push this folder.
2. Go to [https://render.com](https://render.com) and sign in.
3. Click **New +** -> **Blueprint**.
4. Connect your GitHub repo.
5. Render reads `render.yaml` and creates the web service.
6. After deploy, use:
   - `https://your-app.onrender.com/` (players)
   - `https://your-app.onrender.com/admin` (admin)

## Important note about scores
- Current storage is `data.json`.
- On free/standard stateless hosts, file storage may reset on redeploy/restart.
- For persistent scores, move storage to a real database (Supabase/Postgres/MongoDB).

## Files
- `server.js` - API + static hosting
- `public/player.html` - player website
- `public/admin.html` - admin website
- `data.json` - local score storage
- `render.yaml` - Render deployment config
