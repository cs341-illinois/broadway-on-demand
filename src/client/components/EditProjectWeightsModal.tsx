import { useState, useEffect } from "react";
import { Modal, Button, Form, Table, Spinner } from "react-bootstrap";
import { formulateUrl } from "../utils";

interface ProjectComponent {
  assignmentId: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: number;
}

interface ComponentDraft {
  assignmentId: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: string;
}

interface EditProjectWeightsModalProps {
  show: boolean;
  handleClose: () => void;
  courseId: string;
  projectKey: string;
  onSuccess?: () => void;
}

export default function EditProjectWeightsModal({
  show,
  handleClose,
  courseId,
  projectKey,
  onSuccess,
}: EditProjectWeightsModalProps): JSX.Element {
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!show || !courseId || !projectKey) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          formulateUrl(`api/v1/projectGrades/${courseId}/projects`),
          { credentials: "include" },
        );
        if (!res.ok) {
          throw new Error(`Failed to load projects (status ${res.status}).`);
        }
        const projects: { projectKey: string; components: ProjectComponent[] }[] =
          await res.json();
        const project = projects.find((p) => p.projectKey === projectKey);
        if (!project) {
          throw new Error(`Project "${projectKey}" not found.`);
        }
        if (!cancelled) {
          setComponents(
            project.components.map((c) => ({
              assignmentId: c.assignmentId,
              name: c.name,
              gradingMode: c.gradingMode,
              weight: String(c.weight),
            })),
          );
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [show, courseId, projectKey]);

  const updateWeight = (assignmentId: string, value: string) => {
    setComponents(
      components.map((c) =>
        c.assignmentId === assignmentId ? { ...c, weight: value } : c,
      ),
    );
  };

  const onSubmit = async () => {
    setError(null);
    const parsed = components.map((c) => ({
      assignmentId: c.assignmentId,
      weight: c.weight === "" ? NaN : Number(c.weight),
    }));
    for (const c of parsed) {
      if (Number.isNaN(c.weight) || c.weight < 0) {
        setError("Weights must be non-negative numbers.");
        return;
      }
    }
    const total = parsed.reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(total - 100) > 0.001) {
      setError(`Weights must sum to 100 (currently ${total}).`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        formulateUrl(`api/v1/projectGrades/${courseId}/${projectKey}/weights`),
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ components: parsed }),
        },
      );
      if (!res.ok) {
        let message = `Failed to update weights (status ${res.status}).`;
        try {
          const data = await res.json();
          message = data.message || message;
        } catch (e) {
          /* ignore */
        }
        throw new Error(message);
      }
      onSuccess?.();
      handleClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Edit Grade Breakdown — {projectKey}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {loading && (
          <div className="text-center">
            <Spinner animation="border" role="status" />
          </div>
        )}
        {!loading && components.length > 0 && (
          <>
            <p className="text-muted">
              Adjust the weight (%) of each component. Weights must sum to 100
              when saving.
            </p>
            <Table bordered size="sm" className="mb-2">
              <thead>
                <tr>
                  <th style={{ width: "45%" }}>Name</th>
                  <th style={{ width: "30%" }}>Grading Mode</th>
                  <th style={{ width: "25%" }}>Weight (%)</th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.assignmentId}>
                    <td>{c.name}</td>
                    <td>
                      {c.gradingMode === "AUTOGRADED"
                        ? "Autograded"
                        : "Manual"}
                    </td>
                    <td>
                      <Form.Control
                        size="sm"
                        type="number"
                        min={0}
                        max={100}
                        value={c.weight}
                        onChange={(e) =>
                          updateWeight(c.assignmentId, e.target.value)
                        }
                        disabled={saving}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
        {!loading && components.length === 0 && !error && (
          <p className="text-muted">No components found for this project.</p>
        )}
        {error && (
          <div className="text-danger mt-2">
            <small>{error}</small>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={saving || loading || components.length === 0}
        >
          {saving ? (
            <>
              <Spinner
                as="span"
                size="sm"
                animation="border"
                className="me-2"
              />
              Saving...
            </>
          ) : (
            "Save Weights"
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
