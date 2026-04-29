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
  state?: string;
  trackSummary?: string;
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

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function debugLog(label: string, data?: unknown) {
  console.log(`[PulseCall] ${label}`, data ?? "");
}

function summarizeTrack(track: MediaStreamTrack) {
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: track.kind === "video" ? track.getSettings() : undefined,
  };
}

function summarizeStream(stream: MediaStream) {
  return stream.getTracks().map(summarizeTrack);
}

function summarizeReceiverStats(report: RTCStatsReport) {
  const inboundVideo = [];

  for (const stat of report.values()) {
    if (stat.type === "inbound-rtp" && stat.kind === "video") {
      inboundVideo.push({
        packetsReceived: stat.packetsReceived,
        packetsLost: stat.packetsLost,
        bytesReceived: stat.bytesReceived,
        framesDecoded: stat.framesDecoded,
        framesReceived: stat.framesReceived,
        frameWidth: stat.frameWidth,
        frameHeight: stat.frameHeight,
        jitter: stat.jitter,
      });
    }
  }

  return inboundVideo;
}

function getIceConfiguration(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL?.trim();
  const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME?.trim();
  const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL?.trim();
  const transportPolicy = process.env.NEXT_PUBLIC_WEBRTC_TRANSPORT_POLICY?.trim();

  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl.split(",").map((url) => url.trim()).filter(Boolean),
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return {
    iceServers,
    iceTransportPolicy: transportPolicy === "relay" ? "relay" : "all",
  };
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
  const pendingIceCandidates = useRef<Record<string, RTCIceCandidateInit[]>>({});
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
    debugLog("local media ready", summarizeStream(stream));

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

    const config = getIceConfiguration();
    debugLog("create peer connection", {
      remote,
      iceServers: config.iceServers?.map((server) => ({
        urls: server.urls,
        hasUsername: Boolean(server.username),
        hasCredential: Boolean(server.credential),
      })),
      iceTransportPolicy: config.iceTransportPolicy,
    });

    const connection = new RTCPeerConnection(config);
    connections.current[remote.id] = connection;
    updateRemotePeer(remote.id, { ...remote, connected: false });

    localStream.current?.getTracks().forEach((track) => {
      if (localStream.current) {
        connection.addTrack(track, localStream.current);
        debugLog("added local track to peer", {
          remoteId: remote.id,
          track: summarizeTrack(track),
        });
      }
    });

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        debugLog("send ice candidate", {
          to: remote.id,
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address,
          port: event.candidate.port,
          candidateType: event.candidate.candidate.split(" ")[7],
        });
        send({
          type: "signal",
          to: remote.id,
          payload: { type: "ice", candidate: event.candidate.toJSON() },
        });
      }
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      debugLog("received remote track", {
        remoteId: remote.id,
        track: summarizeTrack(event.track),
        streams: event.streams.map(summarizeStream),
      });

      event.track.onmute = () => {
        debugLog("remote track muted", {
          remoteId: remote.id,
          track: summarizeTrack(event.track),
        });
      };

      event.track.onunmute = () => {
        debugLog("remote track unmuted", {
          remoteId: remote.id,
          track: summarizeTrack(event.track),
        });
      };

      event.track.onended = () => {
        debugLog("remote track ended", {
          remoteId: remote.id,
          track: summarizeTrack(event.track),
        });
      };

      updateRemotePeer(remote.id, {
        ...remote,
        stream,
        connected: true,
        trackSummary: stream
          .getTracks()
          .map((track) => `${track.kind}:${track.readyState}:${track.muted ? "muted" : "unmuted"}`)
          .join(", "),
      });

      window.setTimeout(async () => {
        try {
          debugLog("receiver stats", {
            remoteId: remote.id,
            inboundVideo: summarizeReceiverStats(await connection.getStats()),
          });
        } catch (error) {
          debugLog("receiver stats failed", error);
        }
      }, 3000);
    };

    function updateConnectionState() {
      debugLog("connection state", {
        remoteId: remote.id,
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        iceGatheringState: connection.iceGatheringState,
        signalingState: connection.signalingState,
      });

      updateRemotePeer(remote.id, {
        connected: connection.connectionState === "connected",
        state: connection.iceConnectionState,
      });
    }

    connection.onconnectionstatechange = updateConnectionState;
    connection.oniceconnectionstatechange = updateConnectionState;

    return connection;
  }

  async function flushPendingIceCandidates(peerIdToFlush: string) {
    const connection = connections.current[peerIdToFlush];
    const candidates = pendingIceCandidates.current[peerIdToFlush] || [];

    if (!connection?.remoteDescription || candidates.length === 0) return;

    pendingIceCandidates.current[peerIdToFlush] = [];
    for (const candidate of candidates) {
      await connection.addIceCandidate(candidate);
    }
  }

  async function callPeer(remote: PeerInfo) {
    const connection = createConnection(remote);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    debugLog("send offer", {
      to: remote.id,
      senders: connection.getSenders().map((sender) => ({
        track: sender.track ? summarizeTrack(sender.track) : null,
      })),
    });
    send({
      type: "signal",
      to: remote.id,
      payload: { type: "offer", sdp: offer },
    });
  }

  async function handleSignal(from: string, payload: SignalPayload) {
    const remote = remotePeersRef.current[from] || { id: from, name: "Guest" };
    const connection = createConnection(remote);
    debugLog("handle signal", { from, type: payload.type });

    if (payload.type === "offer") {
      await connection.setRemoteDescription(payload.sdp);
      await flushPendingIceCandidates(from);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      debugLog("send answer", {
        to: from,
        senders: connection.getSenders().map((sender) => ({
          track: sender.track ? summarizeTrack(sender.track) : null,
        })),
      });
      send({
        type: "signal",
        to: from,
        payload: { type: "answer", sdp: answer },
      });
    }

    if (payload.type === "answer") {
      await connection.setRemoteDescription(payload.sdp);
      await flushPendingIceCandidates(from);
      debugLog("answer applied", { from });
    }

    if (payload.type === "ice") {
      if (!connection.remoteDescription) {
        pendingIceCandidates.current[from] = [
          ...(pendingIceCandidates.current[from] || []),
          payload.candidate,
        ];
        debugLog("queued ice candidate", { from, candidate: payload.candidate.candidate });
        return;
      }

      await connection.addIceCandidate(payload.candidate);
      debugLog("added ice candidate", { from, candidate: payload.candidate.candidate });
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
    debugLog("open signaling socket", { signalingUrl });

    ws.onopen = () => {
      debugLog("signaling socket open", { roomId, name: name || "Guest" });
      send({
        type: "join",
        roomId,
        name: name || "Guest",
      });
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      debugLog("signaling message", {
        type: message.type,
        from: "from" in message ? message.from : undefined,
      });

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
        delete pendingIceCandidates.current[message.peerId];
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
      debugLog("signaling socket closed");
      setStatus("Signaling server disconnected");
    };

    ws.onerror = () => {
      debugLog("signaling socket error");
      setStatus("Could not connect to the signaling server");
    };
  }

  function leaveRoom() {
    Object.values(connections.current).forEach((connection) => connection.close());
    connections.current = {};
    pendingIceCandidates.current = {};
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
  const [videoReady, setVideoReady] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  useEffect(() => {
    const element = video.current;
    if (!element || !peer.stream) return;

    setVideoReady(false);
    setPlaybackBlocked(false);
    element.srcObject = peer.stream;
    debugLog("remote video element attached", {
      peerId: peer.id,
      tracks: summarizeStream(peer.stream),
      readyState: element.readyState,
      paused: element.paused,
      muted: element.muted,
    });

    const playRemoteVideo = async () => {
      try {
        await element.play();
        setPlaybackBlocked(false);
        debugLog("remote video play resolved", {
          peerId: peer.id,
          readyState: element.readyState,
          paused: element.paused,
          width: element.videoWidth,
          height: element.videoHeight,
        });
      } catch {
        setPlaybackBlocked(true);
        debugLog("remote video play blocked", {
          peerId: peer.id,
          readyState: element.readyState,
          paused: element.paused,
        });
      }
    };

    playRemoteVideo();
  }, [peer.stream]);

  async function startPlayback() {
    if (!video.current) return;

    try {
      await video.current.play();
      setPlaybackBlocked(false);
      debugLog("manual remote video play resolved", { peerId: peer.id });
    } catch {
      setPlaybackBlocked(true);
      debugLog("manual remote video play blocked", { peerId: peer.id });
    }
  }

  return (
    <article className="tile">
      <video
        ref={video}
        autoPlay
        playsInline
        onCanPlay={startPlayback}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          debugLog("remote video metadata", {
            peerId: peer.id,
            width: element.videoWidth,
            height: element.videoHeight,
            readyState: element.readyState,
          });
        }}
        onPlaying={(event) => {
          const element = event.currentTarget;
          setVideoReady(true);
          debugLog("remote video playing", {
            peerId: peer.id,
            width: element.videoWidth,
            height: element.videoHeight,
            readyState: element.readyState,
          });
        }}
        onWaiting={(event) => {
          debugLog("remote video waiting", {
            peerId: peer.id,
            readyState: event.currentTarget.readyState,
          });
        }}
        onError={(event) => {
          debugLog("remote video error", {
            peerId: peer.id,
            error: event.currentTarget.error?.message,
          });
        }}
      />
      {!peer.stream ? <div className="avatar">{peer.name.slice(0, 1).toUpperCase()}</div> : null}
      {peer.stream && !videoReady ? (
        <button className="videoPrompt" onClick={startPlayback}>
          {playbackBlocked ? "Tap to start video" : "Starting video"}
        </button>
      ) : null}
      <div className="nameplate">
        {peer.name}
        <span className={peer.connected ? "online" : "connecting"}>
          {peer.connected ? "Live" : peer.state || "Connecting"}
        </span>
        {peer.trackSummary ? <span className="connecting">{peer.trackSummary}</span> : null}
      </div>
    </article>
  );
}
