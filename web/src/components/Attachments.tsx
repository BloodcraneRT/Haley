import { Download, FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage, type Attachment } from "../api";
import { useApp } from "../lib/app-context";

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A screenshot preview, loaded with the session's credentials (the file route isn't public). */
function Thumbnail({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .attachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id]);
  if (failed) return null;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="attachment-thumb" title={`Open ${attachment.filename}`}>
      <img src={url} alt={attachment.filename} />
    </a>
  ) : (
    <span className="attachment-thumb is-loading" aria-hidden="true" />
  );
}

/** Files that came with a message: previews for screenshots, chips with size and a download for the rest. */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const { toast } = useApp();
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.kind === "image");
  return (
    <div className="attachments" aria-label="Attachments">
      {images.length > 0 && (
        <div className="attachment-thumbs">
          {images.map((a) => (
            <Thumbnail key={a.id} attachment={a} />
          ))}
        </div>
      )}
      <ul className="attachment-chips">
        {attachments.map((a) => {
          const Icon = a.kind === "image" ? ImageIcon : a.kind === "other" ? Paperclip : FileText;
          return (
            <li key={a.id} className={`attachment-chip ${a.kind === "other" ? "is-listed" : ""}`} title={a.note || undefined}>
              <Icon className="icon-xs" aria-hidden="true" />
              <span className="truncate">{a.filename}</span>
              <span className="muted">{size(a.size)}</span>
              {a.kind !== "other" ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label={`Download ${a.filename}`}
                  title="Download"
                  onClick={() => void api.downloadAttachment(a).catch((err) => toast(errorMessage(err), "error"))}
                >
                  <Download className="icon-xs" aria-hidden="true" />
                </button>
              ) : (
                <span className="muted attachment-note">{a.note}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
