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
  key: string;
  assignmentId?: string;
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

let draftCounter = 0;

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
              key: c.assignmentId,
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

  const updateDraft = (
    key: string,
    field: "name" | "gradingMode" | "weight",
    value: string,
  ) => {
    setComponents(
      components.map((c) =>
        c.key === key ? { ...c, [field]: value } : c,
      ),
    );
  };

  const addDraft = () => {
    setComponents([
      ...components,
      {
        key: `draft-${++draftCounter}`,
        name: "",
        gradingMode: "MANUAL",
        weight: "",
      },
    ]);
  };

  const removeRow = (key: string) => {
    setComponents(components.filter((c) => c.key !== key));
  };

  const onSubmit = async () => {
    setError(null);
    if (components.length === 0) {
      setError("A project must have at least one component.");
      return;
    }
    const parsedWeights: number[] = [];
    for (const c of components) {
      if (!c.assignmentId && !c.name.trim()) {
        setError("Every new component must have a name.");
        return;
      }
      const w = c.weight === "" ? NaN : Number(c.weight);
      if (Number.isNaN(w) || w < 0) {
        setError("Weights must be non-negative numbers.");
        return;
      }
      parsedWeights.push(w);
    }
    if (!components.some((c) => c.gradingMode === "AUTOGRADED")) {
      setError("At least one component must be autograded (for repo assignment).");
      return;
    }
    const totalWeight = parsedWeights.reduce((sum, w) => sum + w, 0);
    if (Math.abs(totalWeight - 100) > 0.001) {
      setError(`Weights must sum to 100 (currently ${totalWeight}).`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        formulateUrl(
          `api/v1/projectGrades/${courseId}/${projectKey}/components`,
        ),
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            components: components.map((c, i) => ({
              ...(c.assignmentId ? { assignmentId: c.assignmentId } : {}),
              name: c.name.trim(),
              gradingMode: c.gradingMode,
              weight: parsedWeights[i],
            })),
          }),
        },
      );
      if (!res.ok) {
        let message = `Failed to update components (status ${res.status}).`;
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
              Adjust weights, add new components (autograded or manual), or
              remove components. Weights must sum to 100 when saving. Removing
              a component that already has grades or extensions is blocked.
            </p>
            <Table bordered size="sm" className="mb-2">
              <thead>
                <tr>
                  <th style={{ width: "35%" }}>Name</th>
                  <th style={{ width: "22%" }}>Grading Mode</th>
                  <th style={{ width: "23%" }}>Weight (%)</th>
                  <th style={{ width: "20%" }}></th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.key}>
                    <td>
                      {c.assignmentId ? (
                        c.name
                      ) : (
                        <Form.Control
                          size="sm"
                          placeholder="e.g. Manual Enter"
                          value={c.name}
                          onChange={(e) =>
                            updateDraft(c.key, "name", e.target.value)
                          }
                          disabled={saving}
                        />
                      )}
                    </td>
                    <td>
                      {c.assignmentId ? (
                        c.gradingMode === "AUTOGRADED" ? (
                          "Autograded"
                        ) : (
                          "Manual"
                        )
                      ) : (
                        <Form.Select
                          size="sm"
                          value={c.gradingMode}
                          onChange={(e) =>
                            updateDraft(c.key, "gradingMode", e.target.value)
                          }
                          disabled={saving}
                        >
                          <option value="AUTOGRADED">Autograded</option>
                          <option value="MANUAL">Manual</option>
                        </Form.Select>
                      )}
                    </td>
                    <td>
                      <Form.Control
                        size="sm"
                        type="number"
                        min={0}
                        max={100}
                        value={c.weight}
                        onChange={(e) =>
                          updateDraft(c.key, "weight", e.target.value)
                        }
                        disabled={saving}
                      />
                    </td>
                    <td className="text-center">
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() => removeRow(c.key)}
                        disabled={saving}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Button
              size="sm"
              variant="outline-primary"
              onClick={addDraft}
              disabled={saving}
            >
              + Add Component
            </Button>
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
            "Save Breakdown"
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
