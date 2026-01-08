# Vox - AI Latency Benchmark

<p align="center">
  <strong>Track AI Performance Across the World</strong>
</p>

<p align="center">
  Automated benchmark testing for conversational AI products. Monitor response latency, interrupt latency, network resilience, naturalness, and noise reduction across multiple regions.
</p>

---

## ✨ Features

### 🕐 Automated Testing
Comprehensive benchmarks run automatically every 8 hours across all selected products and regions.

### 🌍 Multi-Region Coverage
Test from US East, US West, Europe, Asia-Pacific, and more to understand regional performance.

### ⚡ Real-Time Updates
Live data dashboard showing the latest metrics and performance trends as tests complete.

### 📊 5 Key Metrics
- **Response Latency** - Time for AI to generate initial response (ms) - *Lower is better*
- **Interrupt Latency** - Time to process and respond to interruptions (ms) - *Lower is better*
- **Network Resilience** - Stability under varying network conditions (%) - *Higher is better*
- **Naturalness** - Quality and fluency of AI responses (0-100 score) - *Higher is better*
- **Noise Reduction** - Effectiveness at filtering background noise (dB) - *Higher is better*

---

## 🤖 Supported Products

| Product | Provider | Status |
|---------|----------|--------|
| Agora ConvoAI | ConvoAI Engine | ✅ Active |
| LiveKIT Agent | LiveKit | ✅ Active |
| Custom ConvoAI | Custom Solutions | 🔜 Coming Soon |
| RTC Solutions | WebRTC Providers | 📅 Future |

---

## 🛠️ Tech Stack

### Frontend
- **React** with TypeScript
- **Vite** for development and production builds
- **Tailwind CSS** with shadcn/ui component library
- **Wouter** for lightweight client-side routing
- **TanStack React Query** for server state management
- **Recharts** for data visualization
- **Framer Motion** for animations

### Backend
- **Node.js** with Express
- **TypeScript** with ESM modules
- **Drizzle ORM** with PostgreSQL
- **Zod** for schema validation

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/guohai/vox.git
   cd vox
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   # Create a .env file with:
   DATABASE_URL=postgresql://user:password@localhost:5432/vox
   ```

4. **Push database schema**
   ```bash
   npm run db:push
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

The application will be available at `http://localhost:5000`.

---

## 📜 Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run check` | Run TypeScript type checking |
| `npm run db:push` | Push database schema changes |

---

## 📁 Project Structure

```
vox/
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # Utilities and helpers
│   │   └── pages/          # Page components
│   └── public/             # Static assets
├── server/                 # Backend Express server
│   ├── index.ts            # Server entry point
│   ├── routes.ts           # API routes
│   ├── storage.ts          # Data access layer
│   └── vite.ts             # Vite dev server integration
├── shared/                 # Shared code between client/server
│   └── schema.ts           # Database schema definitions
└── script/                 # Build scripts
```

---

## 📄 License

This project is licensed under the MIT License.
