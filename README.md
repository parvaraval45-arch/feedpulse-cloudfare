# FeedPulse

A real-time feedback aggregation and analysis tool built on Cloudflare Workers. FeedPulse collects user feedback from multiple sources, analyzes sentiment using Workers AI, and presents actionable insights through a professional dashboard.

**Live Demo:** [feedpulse.parva-raval45.workers.dev](https://feedpulse.parva-raval45.workers.dev)

## Features

- **Multi-source Feedback Collection** - Aggregate feedback from Twitter/X, Discord, GitHub, and Support channels
- **AI-Powered Analysis** - Automatic sentiment analysis (positive/negative/neutral) and categorization (bug/feature/praise/complaint) using Workers AI
- **Smart Prioritization** - AI-generated priority scores (1-5) based on content urgency and impact
- **Theme Extraction** - Automatic identification of recurring themes across feedback
- **Real-time Insights** - AI-generated summaries including most urgent issues, trending topics, and sentiment trends
- **Advanced Filtering** - Filter by source, sentiment, category, priority, and date range
- **Export Functionality** - Export filtered feedback as CSV for stakeholder sharing
- **Responsive Dashboard** - Professional, Cloudflare-inspired UI design

## Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite)
- **AI:** [Workers AI](https://developers.cloudflare.com/workers-ai/) (Llama 3.1 8B)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Language:** TypeScript

## Project Structure

```
feedpulse/
├── src/
│   └── index.ts        # Main worker with API routes and dashboard
├── schema.sql          # D1 database schema
├── wrangler.jsonc      # Cloudflare Workers configuration
├── package.json
└── tsconfig.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard UI |
| `GET` | `/api/feedback` | List feedback (with filters & pagination) |
| `POST` | `/api/feedback` | Submit new feedback (AI-analyzed) |
| `GET` | `/api/feedback/:id` | Get single feedback item |
| `PATCH` | `/api/feedback/:id` | Update feedback (mark addressed) |
| `GET` | `/api/stats` | Get aggregated statistics |
| `GET` | `/api/insights` | Get AI-generated insights |
| `GET` | `/api/themes` | Get theme distribution |
| `POST` | `/api/seed` | Seed database with sample data |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/parvaraval45-arch/feedpulse-cloudfare.git
   cd feedpulse-cloudfare
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a D1 database:
   ```bash
   wrangler d1 create feedpulse-db
   ```

4. Update `wrangler.jsonc` with your database ID

5. Initialize the database schema:
   ```bash
   wrangler d1 execute feedpulse-db --file=./schema.sql
   ```

6. Start development server:
   ```bash
   npm run dev
   ```

### Deployment

```bash
npm run deploy
```

## Database Schema

```sql
CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,        -- twitter, discord, github, support
    content TEXT NOT NULL,
    sentiment TEXT NOT NULL,     -- positive, negative, neutral
    category TEXT NOT NULL,      -- bug, feature, praise, complaint
    priority INTEGER NOT NULL,   -- 1-5
    created_at TEXT,
    themes TEXT DEFAULT '[]',    -- JSON array of themes
    addressed INTEGER DEFAULT 0,
    addressed_at TEXT
);
```

## License

MIT
