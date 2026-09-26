// Full-screen photos: swipe between them, pinch or double-tap to zoom (scroll or click on a computer), drag to look
// around a zoomed photo. PhotoSwipe does the gestures; it needs each photo's size up front, which the API gives
// (upright, as phone photos in portrait are stored sideways with a tag). The phone's Back button closes it rather
// than leaving the page. Floor plans open in their own viewer, not here.
import PhotoSwipe from "photoswipe";
import "photoswipe/style.css";
import { useEffect } from "react";

export type Photo = { id: string; width?: number | null; height?: number | null; caption: string | null };

export default function PhotoViewer({ photos, start, onClose }: { photos: Photo[]; start: number; onClose: () => void }) {
  useEffect(() => {
    const pswp = new PhotoSwipe({
      dataSource: photos.map((p) => ({
        src: `/api/attachments/${p.id}/file`, msrc: `/api/attachments/${p.id}/thumb`,
        width: p.width ?? 1600, height: p.height ?? 1200, alt: p.caption ?? "Photo of the house",
      })),
      index: start,
      bgOpacity: 1,
      // A tap or double tap zooms to about three times the screen (a phone) or the photo's full size (a computer), and
      // back; pinching goes as far as twice full size. (PhotoSwipe's numbers are of the photo's own size.)
      initialZoomLevel: "fit",
      secondaryZoomLevel: (z) => Math.max(Math.min(1, z.fit * 3), z.fit * 1.5),
      maxZoomLevel: (z) => Math.max(2, z.fit * 6),
      wheelToZoom: true,
      showHideAnimationType: "fade",
      closeTitle: "Close (Esc)", zoomTitle: "Zoom in or out", arrowPrevTitle: "Previous", arrowNextTitle: "Next",
      errorMsg: "This photo couldn't be loaded.",
    });
    // Back closes the viewer: a history entry for it, gone again however it's closed.
    let viaBack = false;
    const onBack = () => { viaBack = true; pswp.close(); };
    window.history.pushState({ ...window.history.state, photoViewer: true }, "");
    window.addEventListener("popstate", onBack);
    pswp.on("destroy", () => {
      window.removeEventListener("popstate", onBack);
      if (!viaBack && window.history.state?.photoViewer) window.history.back();
      onClose();
    });
    pswp.init();
    return () => { if (!pswp.isDestroying) pswp.destroy(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
