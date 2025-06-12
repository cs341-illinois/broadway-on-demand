import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal, Button, Form } from "react-bootstrap";
import {
  createManualAssignmentBodySchema,
  CategoryLabels,
  AssignmentVisibilityLabels,
  ManualAssignmentFormData,
} from "../../types/assignment";
import { AssignmentVisibility, Category } from "../enums";
import { useEffect } from "react"; // Removed useState as startData is no longer needed
import { AssignmentModalProps } from "./CreateAssignmentModal";

export default function ManualAssignmentModal({
  show,
  handleClose,
  handleSubmit: onExternalSubmit,
  initialData,
  disabled,
  verb,
}: AssignmentModalProps<ManualAssignmentFormData>) {
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    control,
    setValue,
  } = useForm<ManualAssignmentFormData>({
    resolver: zodResolver(createManualAssignmentBodySchema),
    // Define base default values for the form
    defaultValues: {
      name: "",
      id: "",
      visibility: AssignmentVisibility.DEFAULT,
      category: Category.LAB, // Or your preferred default category
    },
    disabled,
  });

  // Effect to reset the form with initialData when the modal is shown or initialData changes
  useEffect(() => {
    if (show) {
      const newFormValues = {
        name: "",
        id: "",
        visibility: AssignmentVisibility.DEFAULT,
        category: Category.LAB,
        ...(initialData || {}),
      };
      reset(newFormValues);
    }
  }, [initialData, show, reset]);

  const onSubmit = (data: ManualAssignmentFormData) => {
    onExternalSubmit(data);
    reset();
    handleClose();
  };

  const nameValue = useWatch({
    control,
    name: "name",
  });

  useEffect(() => {
    if (!verb) {
      if (nameValue) {
        const generatedId = nameValue
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replaceAll("part_", "pt")
          .replaceAll("week_", "week");
        setValue("id", generatedId, { shouldValidate: true, shouldDirty: true });
      }
    }
  }, [nameValue, setValue, verb]);

  return (
    <Modal
      show={show}
      onHide={() => {
        // It's good practice to also reset on hide if changes shouldn't persist
        // reset(); // Uncomment if you want to ensure form is clean if closed via backdrop/esc
        handleClose();
      }}
    >
      <Form onSubmit={handleSubmit(onSubmit)}>
        <Modal.Header closeButton>
          <Modal.Title>{`${verb || "Create"} Manual Assignment`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Name</Form.Label>
            <Form.Control
              {...register("name")}
              isInvalid={!!errors.name}
              autoFocus /* Good for usability */
            />
            <Form.Control.Feedback type="invalid">
              {errors.name?.message}
            </Form.Control.Feedback>
          </Form.Group>
          {(!verb || verb === "create") && (
            <Form.Group className="mb-3">
              <Form.Label>ID</Form.Label>
              <Form.Control {...register("id")} isInvalid={!!errors.id} />
              <Form.Control.Feedback type="invalid">
                {errors.id?.message}
              </Form.Control.Feedback>
            </Form.Group>
          )}

          <Form.Group className="mb-3">
            <Form.Label>Category</Form.Label>
            <Form.Select
              {...register("category")}
              isInvalid={!!errors.category}
            >
              {Object.values(Category).map((v) => (
                <option key={v} value={v}>
                  {CategoryLabels[v]}
                </option>
              ))}
            </Form.Select>
            <Form.Control.Feedback type="invalid">
              {errors.category?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Visibility</Form.Label>
            <Form.Select
              {...register("visibility")}
              isInvalid={!!errors.visibility}
            >
              {Object.values(AssignmentVisibility).map((v) => (
                <option key={v} value={v}>
                  {AssignmentVisibilityLabels[v]}
                </option>
              ))}
            </Form.Select>
            <Form.Control.Feedback type="invalid">
              {errors.visibility?.message}
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
          <Button variant="primary" type="submit" disabled={disabled}>
            {verb || "Create"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
