import {
  CanonicalView,
  FilteringState,
  Viewer,
  IntersectionQuery,
  DefaultViewerParams,
  Box3,
  SpeckleView
} from '@speckle/viewer'
import { pickViewableHit, projectToScreen } from '../utils/viewerUtils'
import { SpeckleVisualSettings } from '../settings'
import { SettingsChangedType, Tracker } from '../utils/mixpanel'
import _ from 'lodash'

export default class ViewerHandler {
  private viewer: Viewer
  private readonly parent: HTMLElement
  private state: FilteringState
  private loadedObjectsCache: Set<string> = new Set<string>()
  private settings = {
    authToken: null,
    batchSize: 25
  }
  private currentSectionBox: Box3 = null

  public getViews() {
    return this.viewer.getViews()
  }

  public setView(view: SpeckleView | CanonicalView) {
    this.viewer.setView(view)
    if (typeof view === 'string') this.viewer.zoom([...this.loadedObjectsCache], 10, false)
  }

  public setSectionBox(active: boolean, objectIds: string[]) {
    if (active) {
      if (this.currentSectionBox === null) {
        const bbox = this.viewer.getSectionBoxFromObjects(objectIds)
        this.viewer.setSectionBox(bbox)
        this.currentSectionBox = bbox
      } else {
        const bbox = this.viewer.getCurrentSectionBox()
        if (bbox) this.currentSectionBox = bbox
      }
      this.viewer.sectionBoxOn()
    } else {
      this.viewer.sectionBoxOff()
    }
    this.viewer.requestRender()
  }

  public addCameraUpdateEventListener(listener: (ev) => void) {
    this.viewer.cameraHandler.controls.addEventListener('update', listener)
  }
  public removeCameraUpdateEventListener(listener: (ev) => void) {
    this.viewer.cameraHandler.controls.removeEventListener('update', listener)
  }

  public constructor(parent: HTMLElement) {
    this.parent = parent
  }

  public changeSettings(oldSettings: SpeckleVisualSettings, newSettings: SpeckleVisualSettings) {
    if (oldSettings.camera.orthoMode != newSettings.camera.orthoMode) {
      Tracker.settingsChanged(SettingsChangedType.OrthoMode)
      if (newSettings.camera.orthoMode) this.viewer.cameraHandler?.setOrthoCameraOn()
      else this.viewer.cameraHandler?.setPerspectiveCameraOn()
    }

    if (oldSettings.camera.defaultView != newSettings.camera.defaultView) {
      Tracker.settingsChanged(SettingsChangedType.DefaultCamera)
      this.viewer.setView(newSettings.camera.defaultView as CanonicalView)
    }
  }

  public async init() {
    if (this.viewer) return
    const viewerSettings = DefaultViewerParams
    viewerSettings.showStats = false
    viewerSettings.verbose = false
    const viewer = new Viewer(this.parent, viewerSettings)
    await viewer.init()
    this.viewer = viewer
  }

  public async unloadObjects(
    objects: string[],
    signal?: AbortSignal,
    onObjectUnloaded?: (url: string) => void
  ) {
    for (const url of objects) {
      if (signal?.aborted) return
      await this.viewer
        .cancelLoad(url, true)
        .catch((e) => console.warn('Viewer Unload error', url, e))
        .finally(() => {
          if (this.loadedObjectsCache.has(url)) this.loadedObjectsCache.delete(url)
          if (onObjectUnloaded) onObjectUnloaded(url)
        })
    }
  }

  public async loadObjectsWithAutoUnload(
    objectUrls: string[],
    onLoad: (url: string, index: number) => void,
    onError: (url: string, error: Error) => void,
    signal: AbortSignal
  ) {
    var objectsToUnload = _.difference([...this.loadedObjectsCache], objectUrls)
    await this.unloadObjects(objectsToUnload, signal)
    await this.loadObjects(objectUrls, onLoad, onError, signal)
  }
  public async loadObjects(
    objectUrls: string[],
    onLoad: (url: string, index: number) => void,
    onError: (url: string, error: Error) => void,
    signal: AbortSignal
  ) {
    try {
      let index = 0
      let promises = []
      for (const url of objectUrls) {
        if (signal?.aborted) return
        console.log('Attempting to load', url)
        if (!this.loadedObjectsCache.has(url)) {
          console.log('Object is not in cache')
          const promise = this.viewer
            .loadObjectAsync(url, this.settings.authToken, false)
            .then(() => onLoad(url, index++))
            .catch((e: Error) => onError(url, e))
            .finally(() => {
              if (!this.loadedObjectsCache.has(url)) this.loadedObjectsCache.add(url)
            })
          promises.push(promise)
          if (promises.length == this.settings.batchSize) {
            //this.promises.push(Promise.resolve(this.later(1000)))
            await Promise.all(promises)
            promises = []
          }
        } else {
          console.log('Object was already in cache')
        }
      }
      await Promise.all(promises)
    } catch (error) {
      throw new Error(`Load objects failed: ${error}`)
    }
  }

  public async intersect(coords: { x: number; y: number }) {
    const point = this.viewer.Utils.screenToNDC(
      coords.x,
      coords.y,
      this.parent.clientWidth,
      this.parent.clientHeight
    )
    const intQuery: IntersectionQuery = {
      operation: 'Pick',
      point
    }

    const res = this.viewer.query(intQuery)
    if (!res) return null
    return {
      hit: pickViewableHit(res.objects, this.state),
      objects: res.objects
    }
  }

  public async unIsolateObjects() {
    if (this.state.isolatedObjects)
      this.state = await this.viewer.unIsolateObjects(this.state.isolatedObjects, 'powerbi', true)
  }

  public async isolateObjects(objectIds, ghost = false) {
    this.state = await this.viewer.isolateObjects(objectIds, 'powerbi', true, ghost)
  }

  public async colorObjectsByGroup(
    groups?: {
      objectIds: string[]
      color: string
    }[]
  ) {
    //@ts-ignore
    this.state = await this.viewer.setUserObjectColors(groups ?? [])
  }

  public async clear() {
    if (this.viewer) await this.viewer.unloadAll()
    this.loadedObjectsCache.clear()
  }

  public async selectObjects(objectIds: string[] = null) {
    await this.viewer.resetHighlight()
    const objIds = objectIds ?? []
    this.state = await this.viewer.selectObjects(objIds)
  }

  public getScreenPosition(worldPosition): { x: number; y: number } {
    return projectToScreen(this.viewer.cameraHandler.camera, worldPosition)
  }

  public dispose() {
    this.viewer.cameraHandler.controls.removeAllEventListeners()
    this.viewer.dispose()
    this.viewer = null
  }
}
