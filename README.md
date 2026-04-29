# Videocall

A Next.js video-calling platform with WebRTC peer-to-peer media, a custom WebSocket signaling server, room codes, invite links, microphone and camera controls, and screen sharing.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Scripts

- `npm run dev` starts the custom Next.js and WebSocket server.
- `npm run build` creates a production build.
- `npm start` runs the custom server in production mode after building.
- `npm run signal` starts the standalone WebSocket signaling server on port `3001`.

## Deploying

Vercel can host the Next.js UI, but it does not run the custom long-lived WebSocket server used by this project. Deploy `signaling-server.js` separately to a Node host that supports WebSockets, such as Render, Railway, Fly.io, or a VPS.

Set this environment variable in Vercel after deploying the signaling server:

```bash
NEXT_PUBLIC_SIGNALING_URL=wss://your-signaling-server.example.com/ws
```

Without that environment variable, the app tries to connect to `/ws` on the same domain. That works locally with `npm run dev`, but not on a standard Vercel deployment.
