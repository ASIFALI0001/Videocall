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

### Render Example

This repo includes `render.yaml`. On Render, create a new Blueprint from the GitHub repository and Render will start the signaling service with:

```bash
npm run signal
```

After Render deploys, copy its public URL and convert it to WebSocket format:

```bash
https://videocall-signaling.onrender.com
wss://videocall-signaling.onrender.com/ws
```

Set this environment variable in Vercel after deploying the signaling server:

```bash
NEXT_PUBLIC_SIGNALING_URL=wss://your-signaling-server.example.com/ws
```

Without that environment variable, the app tries to connect to `/ws` on the same domain. That works locally with `npm run dev`, but not on a standard Vercel deployment.

## TURN Relay

If users join the same room but stay stuck on `checking`, signaling is working but the browsers cannot create a direct peer-to-peer media path. Add a TURN service and set these Vercel environment variables:

```bash
NEXT_PUBLIC_TURN_URL=turn:your-turn-server.example.com:3478
NEXT_PUBLIC_TURN_USERNAME=your-turn-username
NEXT_PUBLIC_TURN_CREDENTIAL=your-turn-password
```

For testing, you can temporarily force all WebRTC traffic through TURN:

```bash
NEXT_PUBLIC_WEBRTC_TRANSPORT_POLICY=relay
```

After changing any `NEXT_PUBLIC_` variable in Vercel, redeploy the app.
