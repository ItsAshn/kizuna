import { create } from 'zustand'

import type { MonitorInfo } from '@kizuna/shared'

export type DMCallStatus = 'idle' | 'ringing-incoming' | 'ringing-outgoing' | 'active'

export interface DMIncomingCall {
  dmChannelId: string
  callerUserId: string
  callerUsername: string
  calleeUserId: string
  calleeUsername: string
}

interface CallState {
  dmCallStatus: DMCallStatus
  dmCallChannelId: string | null
  dmCallOtherUserId: string | null
  dmCallOtherUsername: string | null
  incomingCall: DMIncomingCall | null
  dmCallShouldCleanup: boolean

  screenSharePeerId: string | null
  screenShareUsername: string | null
  isScreenSharing: boolean
  screenShareVideoProducerId: string | null
  availableMonitors: MonitorInfo[]

  isCameraOn: boolean
  localCameraVideoProducerId: string | null

  setDMCallStatus: (status: DMCallStatus) => void
  setDMCallChannelId: (channelId: string | null) => void
  setDMCallOtherUser: (userId: string | null, username: string | null) => void
  setIncomingCall: (call: DMIncomingCall | null) => void
  setDMCallShouldCleanup: (should: boolean) => void
  clearDMCall: () => void

  setScreenSharePeer: (peerId: string | null, username: string | null) => void
  clearScreenSharePeer: () => void
  setIsScreenSharing: (active: boolean) => void
  setScreenShareVideoProducerId: (producerId: string | null) => void
  setAvailableMonitors: (monitors: MonitorInfo[]) => void

  setIsCameraOn: (on: boolean) => void
  setLocalCameraVideoProducerId: (producerId: string | null) => void
}

export const useCallStore = create<CallState>()((set) => ({
  dmCallStatus: 'idle',
  dmCallChannelId: null,
  dmCallOtherUserId: null,
  dmCallOtherUsername: null,
  incomingCall: null,
  dmCallShouldCleanup: false,

  screenSharePeerId: null,
  screenShareUsername: null,
  isScreenSharing: false,
  screenShareVideoProducerId: null,
  availableMonitors: [],

  isCameraOn: false,
  localCameraVideoProducerId: null,

  setDMCallStatus: (dmCallStatus) => set({ dmCallStatus }),
  setDMCallChannelId: (dmCallChannelId) => set({ dmCallChannelId }),
  setDMCallOtherUser: (userId, username) =>
    set({ dmCallOtherUserId: userId, dmCallOtherUsername: username }),
  setIncomingCall: (incomingCall) =>
    set({
      incomingCall,
      dmCallStatus: incomingCall ? 'ringing-incoming' : 'idle',
    }),
  setDMCallShouldCleanup: (dmCallShouldCleanup) => set({ dmCallShouldCleanup }),
  clearDMCall: () =>
    set({
      dmCallStatus: 'idle',
      dmCallChannelId: null,
      dmCallOtherUserId: null,
      dmCallOtherUsername: null,
      incomingCall: null,
      dmCallShouldCleanup: false,
    }),

  setScreenSharePeer: (screenSharePeerId, screenShareUsername) =>
    set({ screenSharePeerId, screenShareUsername }),
  clearScreenSharePeer: () => set({ screenSharePeerId: null, screenShareUsername: null }),
  setIsScreenSharing: (isScreenSharing) => set({ isScreenSharing }),
  setScreenShareVideoProducerId: (screenShareVideoProducerId) =>
    set({ screenShareVideoProducerId }),
  setAvailableMonitors: (availableMonitors) => set({ availableMonitors }),

  setIsCameraOn: (isCameraOn) => set({ isCameraOn }),
  setLocalCameraVideoProducerId: (localCameraVideoProducerId) =>
    set({ localCameraVideoProducerId }),
}))
