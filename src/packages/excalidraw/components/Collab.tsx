import throttle from "lodash.throttle";
import { PureComponent } from "react";
import { ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "../../../types";
import { ErrorDialog } from "../../../components/ErrorDialog";
import { APP_NAME, ENV, EVENT } from "../../../constants";
import { ImportedDataState } from "../../../data/types";
import {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
} from "../../../element/types";
import { SocketId } from "../../../types";
import { restoreElements } from "../../../data/restore";
import { Collaborator, Gesture } from "../../../types";
import {
  assertNever,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "../../../utils";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  WS_EVENTS,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../../../excalidraw-app/app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getCollabServer,
  getSyncableElements,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../../../excalidraw-app/data";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../../../excalidraw-app/data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../../../excalidraw-app/data/localStorage";
import Portal from "../../../excalidraw-app/collab/Portal";
// import RoomDialog from "./RoomDialog";
import { t } from "../../../i18n";
import { UserIdleState } from "../../../types";
import { IDLE_THRESHOLD, ACTIVE_THRESHOLD } from "../../../constants";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../../../excalidraw-app/data/FileManager";
import { AbortError } from "../../../errors";
import {
  isImageElement,
  isInitializedImageElement,
} from "../../../element/typeChecks";
import { newElementWith } from "../../../element/mutateElement";
import { decryptData } from "../../../data/encryption";
import { resetBrowserStateVersions } from "../../../excalidraw-app/data/tabSync";
import { LocalData } from "../../../excalidraw-app/data/LocalData";
import { atom, useAtom } from "jotai";
import { appJotaiStore } from "../../../excalidraw-app/app-jotai";
import {
  reconcileElements,
  type ReconciledExcalidrawElement,
  type RemoteExcalidrawElement,
} from "../../../data/reconcile";
import { Mutable, ValueOf } from "../../../utility-types";
import { withBatchedUpdates } from "../../../reactUtils";
import { zoomToFitBounds } from "../../../actions/actionCanvas";
import { StoreAction } from "../../../store";
import { collabErrorIndicatorAtom } from "../../../excalidraw-app/collab/CollabError";
import { getVisibleSceneBounds } from "../../../element/bounds";
import { hashElementsVersion } from "../../../element";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const collabDialogShownAtom = atom(false);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string | null;
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
}

interface PublicProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: "",
    };
    // @ts-ignore
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (import.meta.env.MODE === ENV.TEST || import.meta.env.DEV) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      preventUnload(event);
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (this.isCollaborating() && storedElements) {
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
      }
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }
      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        storeAction: StoreAction.UPDATE,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileHandled(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
            Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
      );

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(
        socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
          transports: ["websocket", "polling"],
        }),
        roomId,
        roomKey,
      );

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    if (!existingRoomLinkData) {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        storeAction: StoreAction.UPDATE,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const remoteElements = decryptedData.payload.elements;
              const reconciledElements =
                this._reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SUBTYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this._reconcileElements(decryptedData.payload.elements),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const appState = this.excalidrawAPI.getAppState();

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (appState.userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (
              appState.userToFollow &&
              appState.followedBy.has(appState.userToFollow.socketId)
            ) {
              return;
            }

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fitToViewport: true,
                viewportZoomFactor: 1,
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.excalidrawAPI.updateScene({
          appState: { followedBy: new Set(followedBy) },
        });

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private initializeRoom = async ({
                                    fetchScene,
                                    roomLinkData,
                                  }:
                                    | {
                                    fetchScene: true;
                                    roomLinkData: { roomId: string; roomKey: string } | null;
                                  }
                                    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          this.setLastBroadcastedOrReceivedSceneVersion(
            hashElementsVersion(elements),
          );

          return {
            elements,
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  private _reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();
    const restoredRemoteElements = restoreElements(remoteElements, null);
    const reconciledElements = reconcileElements(
      localElements,
      restoredRemoteElements as RemoteExcalidrawElement[],
      appState,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      hashElementsVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      storeAction: StoreAction.UPDATE,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: socketId === this.portal.socket?.id,
        }),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: socketId === this.portal.socket?.id,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
      this.portal.socket &&
      this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      hashElementsVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion =
        hashElementsVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);
    this.queueSaveToFirebase();
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      hashElementsVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  handleClose = () => {
    appJotaiStore.set(collabDialogShownAtom, false);
  };

  getUsername = () => this.state.username;
  getActiveRoomLink = () => this.state.activeRoomLink;

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };
  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collabq: InstanceType<typeof Collab>;
  }
}

if (import.meta.env.MODE === ENV.TEST || import.meta.env.DEV) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;

