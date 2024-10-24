import { css, html, LitElement, nothing, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type GridSelection } from "./common";
import { SpectrumHighlightChangedEvent } from "./events";
import { DefaultZoom, getZoomedFraction, type Zoom } from "./zoom";
import { DragController, DragHandler } from "../controls/drag-controller";

@customElement("rr-highlight")
export class RrHighlight extends LitElement {
  @property({ type: Boolean, reflect: true, attribute: "draggable-point" })
  draggablePoint: boolean = false;
  @property({ type: Boolean, reflect: true, attribute: "draggable-left" })
  draggableLeft: boolean = false;
  @property({ type: Boolean, reflect: true, attribute: "draggable-right" })
  draggableRight: boolean = false;
  @property({ attribute: false })
  zoom: Zoom = DefaultZoom;
  @property({ attribute: false })
  selection?: GridSelection;

  static get styles() {
    return [
      css`
        :host {
          pointer-events: none;
        }

        .handle {
          pointer-events: all;
        }

        #point,
        #band,
        .handle {
          position: absolute;
          top: 0;
          bottom: 0;
        }

        #point {
          width: 2px;
          background: var(--rr-highlight-color, rgba(255, 255, 0, 0.25));
        }

        #band {
          background: var(--rr-highlight-area-color, rgba(255, 255, 255, 0.25));
        }

        .handle {
          width: 4px;
          cursor: ew-resize;
        }

        #pointHandle {
          cursor: col-resize;
        }

        #pointHandle:hover {
          background: var(--rr-highlight-handle-color, rgba(255, 255, 0, 1));
        }

        #leftBandHandle:hover,
        #rightBandHandle:hover {
          background: var(
            --rr-highlight-area-handle-color,
            rgba(255, 255, 255, 1)
          );
        }
      `,
    ];
  }

  render() {
    return html`${this.renderBand()}${this.renderPoint()}`;
  }

  private renderPoint() {
    if (this.selection?.point === undefined) return nothing;
    let c = getZoomedFraction(this.selection.point, this.zoom);
    if (c < 0 || c > 1) return nothing;
    return html`<div id="point" style="left:calc(${100 * c}% - 1px)"></div>
      ${this.draggablePoint
        ? html`<div
            id="pointHandle"
            class="handle"
            style="left:calc(${100 * c}% - 2px)"
            @pointerdown=${this.onPointPointerDown}
          ></div>`
        : nothing}`;
  }

  private renderBand() {
    if (this.selection?.band === undefined) return nothing;
    let l = getZoomedFraction(this.selection.band.left, this.zoom);
    let r = getZoomedFraction(this.selection.band.right, this.zoom);
    if (l > 1 || r < 0) return nothing;
    let le = Math.max(0, l);
    let re = Math.min(r, 1);
    return html`<div
        id="band"
        style="left:${100 * le}%;width:${100 * (re - le)}%"
      ></div>
      ${this.draggableLeft && l == le
        ? html`<div
            id="leftBandHandle"
            class="handle"
            style="left:calc(${100 * l}% - 2px)"
            @pointerdown=${this.onLeftPointerDown}
          ></div>`
        : nothing}${this.draggableRight && r == re
        ? html`<div
            id="rightBandHandle"
            class="handle"
            style="left:calc(${100 * r}% - 2px)"
            @pointerdown=${this.onRightPointerDown}
          ></div>`
        : nothing}`;
  }

  private pointDragController?: DragController;
  private leftDragController?: DragController;
  private rightDragController?: DragController;

  protected firstUpdated(changed: PropertyValues): void {
    super.firstUpdated(changed);
    this.pointDragController = new DragController(
      new HighlightDragHandler("point", this)
    );
    this.leftDragController = new DragController(
      new HighlightDragHandler("start", this)
    );
    this.rightDragController = new DragController(
      new HighlightDragHandler("end", this)
    );
  }

  private onPointPointerDown(e: PointerEvent) {
    this.pointDragController?.startDragging(e);
  }

  private onLeftPointerDown(e: PointerEvent) {
    this.leftDragController?.startDragging(e);
  }

  private onRightPointerDown(e: PointerEvent) {
    this.rightDragController?.startDragging(e);
  }
}

type DragType = "point" | "start" | "end";

class HighlightDragHandler implements DragHandler {
  constructor(
    private type: DragType,
    private highlight: RrHighlight
  ) {}

  private original?: GridSelection;

  startDrag(): void {
    this.original = this.highlight.selection;
  }

  drag(deltaX: number, _: number): void {
    const zoom =
      this.highlight.zoom === undefined ? 1 : this.highlight.zoom.multiplier;
    let fraction = this.getFraction();
    if (fraction !== undefined) {
      fraction += deltaX / (this.highlight.offsetWidth * zoom);
      if (fraction < 0) fraction = 0;
      if (fraction > 1) fraction = 1;
      this.highlight.dispatchEvent(this.getEvent(fraction));
    }
  }

  finishDrag(): void {}

  cancelDrag(): void {
    let fraction = this.getFraction();
    if (fraction !== undefined) {
      this.highlight.dispatchEvent(this.getEvent(fraction));
    }
  }

  private getFraction(): number | undefined {
    return this.type == "point"
      ? this.original?.point
      : this.type == "start"
        ? this.original?.band?.left
        : this.original?.band?.right;
  }

  private getEvent(fraction: number): SpectrumHighlightChangedEvent {
    return new SpectrumHighlightChangedEvent(
      this.type == "point"
        ? { fraction }
        : this.type == "start"
          ? { startFraction: fraction }
          : { endFraction: fraction }
    );
  }
}
