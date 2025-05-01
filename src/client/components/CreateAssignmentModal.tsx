import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal, Button, Form } from "react-bootstrap";
import {
  AssignmentVisibility,
  AssignmentQuota,
  createAssignmentBodySchema,
  AutogradableCategory,
  CategoryLabels,
  AssignmentVisibilityLabels,
} from "../../types/assignment";
import { useEffect } from "react";

// Use the Zod schema from the import
type AssignmentFormData = typeof createAssignmentBodySchema._type;

// Define the component props interface
interface AssignmentModalProps {
  show: boolean;
  handleClose: () => void;
  handleSubmit: (data: AssignmentFormData) => void;
}

export default function AssignmentModal({
  show,
  handleClose,
  handleSubmit: onExternalSubmit,
}: AssignmentModalProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    control,
    setValue,
  } = useForm<AssignmentFormData>({
    resolver: zodResolver(createAssignmentBodySchema),
    defaultValues: {
      name: "",
      id: "",
      visibility: AssignmentVisibility.DEFAULT,
      quotaPeriod: AssignmentQuota.DAILY,
      quotaAmount: 1,
      category: AutogradableCategory.MP,
      openAt: new Date(),
      dueAt: new Date(),
    },
  });

  const onSubmit = (data: AssignmentFormData) => {
    data.quotaAmount = Number(data.quotaAmount);
    onExternalSubmit(data);
    reset();
    handleClose();
  };

  // Watch the name field value
  const nameValue = useWatch({
    control,
    name: "name",
  });

  // Auto-generate ID from name
  useEffect(() => {
    if (nameValue) {
      const generatedId = nameValue.toLowerCase().replace(/\s+/g, "_");
      setValue("id", generatedId);
    }
  }, [nameValue, setValue]);

  return (
    <Modal show={show} onHide={handleClose}>
      <Form onSubmit={handleSubmit(onSubmit)}>
        <Modal.Header closeButton>
          <Modal.Title>Create Assignment</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Name</Form.Label>
            <Form.Control {...register("name")} isInvalid={!!errors.name} />
            <Form.Control.Feedback type="invalid">
              {errors.name?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>ID</Form.Label>
            <Form.Control {...register("id")} isInvalid={!!errors.id} />
            <Form.Control.Feedback type="invalid">
              {errors.id?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Category</Form.Label>
            <Form.Select {...register("category")}>
              {Object.values(AutogradableCategory).map((v) => (
                <option key={v} value={v}>
                  {CategoryLabels[v]}
                </option>
              ))}
            </Form.Select>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Visibility</Form.Label>
            <Form.Select {...register("visibility")}>
              {Object.values(AssignmentVisibility).map((v) => (
                <option key={v} value={v}>
                  {AssignmentVisibilityLabels[v]}
                </option>
              ))}
            </Form.Select>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Quota Amount</Form.Label>
            <Form.Control
              type="number"
              min="1"
              {...register("quotaAmount", {
                required: "Quota is required",
                min: { value: 1, message: "Quota must be at least 1" },
              })}
              isInvalid={!!errors.quotaAmount}
            />
            <Form.Control.Feedback type="invalid">
              {errors.quotaAmount?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Quota Period</Form.Label>
            <Form.Select {...register("quotaPeriod")}>
              {Object.values(AssignmentQuota).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Form.Select>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Opens At</Form.Label>
            <Form.Control
              type="datetime-local"
              {...register("openAt", { required: "Open date is required" })}
              isInvalid={!!errors.openAt}
            />
            <Form.Control.Feedback type="invalid">
              {errors.openAt?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Due At</Form.Label>
            <Form.Control
              type="datetime-local"
              {...register("dueAt", { required: "Due date is required" })}
              isInvalid={!!errors.dueAt}
            />
            <Form.Control.Feedback type="invalid">
              {errors.dueAt?.message}
            </Form.Control.Feedback>
          </Form.Group>
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
          <Button variant="primary" type="submit">
            Create
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
