import { useState } from "react";
import { Modal, Button, Form, Badge, Table } from "react-bootstrap";

interface ProjectComponent {
  id: string;
  name: string;
  gradingMode: "AUTOGRADED" | "MANUAL";
  weight: number;
}

interface CreateProjectModalProps {
  show: boolean;
  handleClose: () => void;
  handleSubmit: (data: {
    projectKey: string;
    repoProjectName: string;
    components: ProjectComponent[];
  }) => Promise<void>;
  disabled?: boolean;
}

let componentCounter = 0;

export default function CreateProjectModal({
  show,
  handleClose,
  handleSubmit,
  disabled,
}: CreateProjectModalProps) {
  const [projectKey, setProjectKey] = useState("");
  const [repoProjectName, setRepoProjectName] = useState("");
  const [repoCount, setRepoCount] = useState(200);
  const [components, setComponents] = useState<ProjectComponent[]>([
    { id: `c${++componentCounter}`, name: "", gradingMode: "AUTOGRADED", weight: 0 },
  ]);
  const [error, setError] = useState<string | null>(null);

  const totalWeight = components.reduce((sum, c) => sum + (c.weight || 0), 0);

  const repoPreview = repoProjectName
    ? `{prefix}.${repoProjectName}.team-01 … team-${String(repoCount).padStart(2, "0")}`
    : "Enter a repo project name to preview";

  const addComponent = () => {
    setComponents([
      ...components,
      { id: `c${++componentCounter}`, name: "", gradingMode: "MANUAL", weight: 0 },
    ]);
  };

  const removeComponent = (id: string) => {
    if (components.length <= 1) return;
    setComponents(components.filter((c) => c.id !== id));
  };

  const updateComponent = (id: string, field: keyof ProjectComponent, value: string | number) => {
    setComponents(
      components.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    );
  };

  const reset = () => {
    setProjectKey("");
    setRepoProjectName("");
    setRepoCount(200);
    setComponents([
      { id: `c${++componentCounter}`, name: "", gradingMode: "AUTOGRADED", weight: 0 },
    ]);
    setError(null);
  };

  const onSubmit = async () => {
    setError(null);
    if (!projectKey.trim()) {
      setError("Project key is required.");
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(projectKey.trim())) {
      setError("Project key must contain only letters, numbers, hyphens, and underscores.");
      return;
    }
    if (!repoProjectName.trim()) {
      setError("Repo project name is required (e.g. project-01).");
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(repoProjectName.trim())) {
      setError("Repo project name must contain only letters, numbers, hyphens, and underscores.");
      return;
    }
    for (const c of components) {
      if (!c.name.trim()) {
        setError("Every component must have a name.");
        return;
      }
      if (c.weight < 0) {
        setError("Weights must be non-negative.");
        return;
      }
    }
    if (totalWeight !== 100) {
      setError(`Weights must sum to 100 (currently ${totalWeight}).`);
      return;
    }
    const hasAutograded = components.some((c) => c.gradingMode === "AUTOGRADED");
    if (!hasAutograded) {
      setError("At least one component must be autograded (for repo assignment).");
      return;
    }
    try {
      await handleSubmit({
        projectKey: projectKey.trim(),
        repoProjectName: repoProjectName.trim(),
        components: components.map((c) => ({
          ...c,
          name: c.name.trim(),
          id: `${projectKey.trim()}-${c.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`,
        })),
      });
      reset();
      handleClose();
    } catch (e: any) {
      setError(e.message || "Failed to create project.");
    }
  };

  return (
    <Modal show={show} onHide={handleClose} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>Create Project</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label>Project Key</Form.Label>
          <Form.Control
            type="text"
            placeholder="e.g. project1"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
            isInvalid={!!error && !projectKey.trim()}
          />
          <Form.Text className="text-muted">
            Unique identifier for this project. Components will share this key.
          </Form.Text>
        </Form.Group>

        <Form.Group className="mb-3">
          <Form.Label>Repo Project Name</Form.Label>
          <Form.Control
            type="text"
            placeholder="e.g. project-01"
            value={repoProjectName}
            onChange={(e) => setRepoProjectName(e.target.value)}
            isInvalid={!!error && !repoProjectName.trim()}
          />
          <Form.Text className="text-muted">
            Used in repo names: <code>{`{prefix}.${repoProjectName || "project-01"}.team-01`}</code>.
            After creating, run: <code>{`npx tsx src/scripts/importProjectRepoPool.ts <courseId> ${projectKey || "project1"} ${repoProjectName || "project-01"} ${repoCount}`}</code>
          </Form.Text>
        </Form.Group>

        <div className="d-flex justify-content-between align-items-center mb-2">
          <h5 className="mb-0">Components</h5>
          <Badge bg={totalWeight === 100 ? "success" : "warning"}>
            Total weight: {totalWeight}%
          </Badge>
        </div>

        <Table bordered size="sm" className="mb-2">
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Name</th>
              <th style={{ width: "25%" }}>Grading Mode</th>
              <th style={{ width: "20%" }}>Weight (%)</th>
              <th style={{ width: "15%" }}></th>
            </tr>
          </thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td>
                  <Form.Control
                    size="sm"
                    placeholder="e.g. Autograded"
                    value={c.name}
                    onChange={(e) => updateComponent(c.id, "name", e.target.value)}
                    disabled={disabled}
                  />
                </td>
                <td>
                  <Form.Select
                    size="sm"
                    value={c.gradingMode}
                    onChange={(e) => updateComponent(c.id, "gradingMode", e.target.value)}
                    disabled={disabled}
                  >
                    <option value="AUTOGRADED">Autograded</option>
                    <option value="MANUAL">Manual</option>
                  </Form.Select>
                </td>
                <td>
                  <Form.Control
                    size="sm"
                    type="number"
                    min={0}
                    max={100}
                    value={c.weight}
                    onChange={(e) =>
                      updateComponent(c.id, "weight", Number(e.target.value))
                    }
                    disabled={disabled}
                  />
                </td>
                <td className="text-center">
                  <Button
                    size="sm"
                    variant="outline-danger"
                    onClick={() => removeComponent(c.id)}
                    disabled={disabled || components.length <= 1}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>

        <Button size="sm" variant="outline-primary" onClick={addComponent} disabled={disabled}>
          + Add Component
        </Button>

        {error && (
          <div className="text-danger mt-2">
            <small>{error}</small>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="secondary"
          onClick={() => {
            reset();
            handleClose();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" onClick={onSubmit} disabled={disabled}>
          Create Project
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
