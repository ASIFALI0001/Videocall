"use client";

import {
  Copy,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type PeerInfo = {
  id: string;
  name: string;
};

type RemotePeer = PeerInfo & {
  stream?: MediaStream;
  connected: boolean;
};

type SignalPayload =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit };

type ServerMessage =
  | { type: "joined"; peerId: string; peers: PeerInfo[] }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; from: string; payload: SignalPayload }
  | { type: "error"; message: string };

const iceServers: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getSignalingUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SIGNALING_URL?.trim();
  if (configuredUrl) return configuredUrl;

  if (window.location.hostname.endsWith(".vercel.app")) {
    return null;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [remotePeers, setRemotePeers] = useState<Record<string, RemotePeer>>({});
  const [status, setStatus] = useState("Ready to start a room");
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [sharing, setSharing] = useState(false);

  const localVideo = useRef<HTMLVideoElement | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const connections = useRef<Record<string, RTCPeerConnection>>({});
  const remotePeersRef = useRef<Record<string, RemotePeer>>({});

  const inviteLink = useMemo(() => {
    if (!roomId || typeof window === "undefined") return "";
    return `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
  }, [roomId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get("room");
    setRoomId(urlRoom || createRoomId());
  }, []);

  useEffect(() => {
    return () => {
      leaveRoom();
    };
  }, []);

  useEffect(() => {
    remotePeersRef.current = remotePeers;
  }, [remotePeers]);

  async function ensureMedia() {
    if (localStream.current) return localStream.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    cameraStream.current = stream;
    localStream.current = stream;

    if (localVideo.current) {
      localVideo.current.srcObject = stream;
    }

    return stream;
  }

  function send(message: unknown) {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(message));
    }
  }

  function updateRemotePeer(id: string, patch: Partial<RemotePeer>) {
    setRemotePeers((current) => ({
      ...current,
      [id]: {
        ...current[id],
        ...patch,
        id,
        name: patch.name || current[id]?.name || "Guest",
        connected: patch.connected ?? current[id]?.connected ?? false,
      },
    }));
  }

  function createConnection(remote: PeerInfo) {
    const existing = connections.current[remote.id];
    if (existing) return existing;

    const connection = new RTCPeerConnection(iceServers);
    connections.current[remote.id] = connection;
    updateRemotePeer(remote.id, { ...remote, connected: false });

    localStream.current?.getTracks().forEach((track) => {
      if (localStream.current) {
        connection.addTrack(track, localStream.current);
      }
    });

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        send({
          type: "signal",
          to: remote.id,
          payload: { type: "ice", candidate: event.candidate.toJSON() },
        });
      }
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      updateRemotePeer(remote.id, {
        ...remote,
        stream,
        connected: true,
      });
    };

    connection.onconnectionstatechange = () => {
      updateRemotePeer(remote.id, {
        connected: connection.connectionState === "connected",
      });
    };

    return connection;
  }

  async function callPeer(remote: PeerInfo) {
    const connection = createConnection(remote);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    send({
      type: "signal",
      to: remote.id,
      payload: { type: "offer", sdp: offer },
    });
  }

  async function handleSignal(from: string, payload: SignalPayload) {
    const remote = remotePeersRef.current[from] || { id: from, name: "Guest" };
    const connection = createConnection(remote);

    if (payload.type === "offer") {
      await connection.setRemoteDescription(payload.sdp);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      send({
        type: "signal",
        to: from,
        payload: { type: "answer", sdp: answer },
      });
    }

    if (payload.type === "answer") {
      await connection.setRemoteDescription(payload.sdp);
    }

    if (payload.type === "ice") {
      await connection.addIceCandidate(payload.candidate);
    }
  }

  async function joinRoom() {
    setStatus("Opening camera and microphone...");
    await ensureMedia();

    const signalingUrl = getSignalingUrl();
    if (!signalingUrl) {
      setStatus("Set NEXT_PUBLIC_SIGNALING_URL in Vercel to your WebSocket server");
      return;
    }

    const ws = new WebSocket(signalingUrl);
    socket.current = ws;

    ws.onopen = () => {
      send({
        type: "join",
        roomId,
        name: name || "Guest",
      });
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data) as ServerMessage;

      if (message.type === "joined") {
        setPeerId(message.peerId);
        setJoined(true);
        setStatus(message.peers.length ? "Connecting to room..." : "Waiting for people to join");
        setRemotePeers(
          Object.fromEntries(
            message.peers.map((peer) => [peer.id, { ...peer, connected: false }]),
          ),
        );

        for (const peer of message.peers) {
          await callPeer(peer);
        }
      }

      if (message.type === "peer-joined") {
        updateRemotePeer(message.peer.id, {
          ...message.peer,
          connected: false,
        });
        setStatus(`${message.peer.name} joined`);
      }

      if (message.type === "peer-left") {
        connections.current[message.peerId]?.close();
        delete connections.current[message.peerId];
        setRemotePeers((current) => {
          const next = { ...current };
          delete next[message.peerId];
          return next;
        });
      }

      if (message.type === "signal") {
        await handleSignal(message.from, message.payload);
      }

      if (message.type === "error") {
        setStatus(message.message);
      }
    };

    ws.onclose = () => {
      setStatus("Signaling server disconnected");
    };

    ws.onerror = () => {
      setStatus("Could not connect to the signaling server");
    };
  }

  function leaveRoom() {
    Object.values(connections.current).forEach((connection) => connection.close());
    connections.current = {};
    socket.current?.close();
    socket.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    screenStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    cameraStream.current = null;
    screenStream.current = null;
    setJoined(false);
    setRemotePeers({});
    setStatus("Call ended");
  }

  function toggleMic() {
    localStream.current?.getAudioTracks().forEach((track) => {
      track.enabled = !micOn;
    });
    setMicOn((value) => !value);
  }

  function toggleCamera() {
    localStream.current?.getVideoTracks().forEach((track) => {
      track.enabled = !cameraOn;
    });
    setCameraOn((value) => !value);
  }

  async function replaceVideoTrack(track: MediaStreamTrack) {
    await Promise.all(
      Object.values(connections.current).map(async (connection) => {
        const sender = connection.getSenders().find((item) => item.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
      }),
    );
  }

  async function toggleScreenShare() {
    if (!sharing) {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const [track] = stream.getVideoTracks();
      screenStream.current = stream;
      await replaceVideoTrack(track);

      if (localVideo.current) localVideo.current.srcObject = stream;
      track.onended = () => stopScreenShare();
      setSharing(true);
      return;
    }

    await stopScreenShare();
  }

  async function stopScreenShare() {
    const cameraTrack = cameraStream.current?.getVideoTracks()[0];
    if (!cameraTrack) return;

    await replaceVideoTrack(cameraTrack);
    screenStream.current?.getTracks().forEach((track) => track.stop());
    screenStream.current = null;
    if (localVideo.current && localStream.current) {
      localVideo.current.srcObject = localStream.current;
    }
    setSharing(false);
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteLink);
    setStatus("Invite link copied");
  }

  const remotes = Object.values(remotePeers);

  return (
    <main className="shell">
      <section className="sidebar" aria-label="Call setup">
        <div>
          <p className="eyebrow">PulseCall</p>
          <h1>Video rooms for focused conversations.</h1>
          <p className="lede">
            Create a room, share the link, and connect through peer-to-peer video.
          </p>
        </div>

        <label>
          Display name
          <input
            value={name}
            disabled={joined}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ayesha"
          />
        </label>

        <label>
          Room code
          <input
            value={roomId}
            disabled={joined}
            onChange={(event) => setRoomId(event.target.value.toUpperCase())}
          />
        </label>

        <div className="actions">
          {!joined ? (
            <button className="primary" onClick={joinRoom}>
              <Phone size={18} />
              Join call
            </button>
          ) : (
            <button className="danger" onClick={leaveRoom}>
              <PhoneOff size={18} />
              Leave
            </button>
          )}
          <button className="iconButton" onClick={copyInvite} disabled={!roomId} title="Copy invite">
            <Copy size={18} />
          </button>
        </div>

        <div className="status">
          <span />
          {status}
        </div>
      </section>

      <section className="stage" aria-label="Video call">
        <div className="videoGrid">
          <article className="tile localTile">
            <video ref={localVideo} autoPlay muted playsInline />
            <div className="nameplate">{name || "You"} {peerId ? "(you)" : ""}</div>
          </article>

          {remotes.map((peer) => (
            <RemoteTile key={peer.id} peer={peer} />
          ))}

          {joined && remotes.length === 0 ? (
            <div className="emptyState">
              <h2>Room is open</h2>
              <p>Share the invite link to bring someone into the call.</p>
            </div>
          ) : null}
        </div>

        <div className="toolbar" aria-label="Call controls">
          <button onClick={toggleMic} disabled={!joined} title={micOn ? "Mute microphone" : "Unmute microphone"}>
            {micOn ? <Mic size={20} /> : <MicOff size={20} />}
          </button>
          <button onClick={toggleCamera} disabled={!joined} title={cameraOn ? "Turn camera off" : "Turn camera on"}>
            {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
          </button>
          <button onClick={toggleScreenShare} disabled={!joined} className={sharing ? "active" : ""} title="Share screen">
            <MonitorUp size={20} />
          </button>
        </div>
      </section>
    </main>
  );
}

function RemoteTile({ peer }: { peer: RemotePeer }) {
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (video.current && peer.stream) {
      video.current.srcObject = peer.stream;
    }
  }, [peer.stream]);

  return (
    <article className="tile">
      <video ref={video} autoPlay playsInline />
      {!peer.stream ? <div className="avatar">{peer.name.slice(0, 1).toUpperCase()}</div> : null}
      <div className="nameplate">
        {peer.name}
        <span className={peer.connected ? "online" : "connecting"}>
          {peer.connected ? "Live" : "Connecting"}
        </span>
      </div>
    </article>
  );
}
