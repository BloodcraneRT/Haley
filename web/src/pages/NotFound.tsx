import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/Feedback";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <div className="card">
      <EmptyState
        icon={<Compass className="icon" />}
        title="Page not found"
        actions={
          <Link to="/" className="btn btn-primary">
            Go to dashboard
          </Link>
        }
      >
        The link may be out of date, or the record was deleted.
      </EmptyState>
    </div>
  );
}
