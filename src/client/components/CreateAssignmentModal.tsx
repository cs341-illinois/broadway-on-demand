import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal, Button, Form } from "react-bootstrap";
import {
  createAssignmentBodySchema,
  CategoryLabels,
  AssignmentVisibilityLabels,
} from "../../types/assignment";
import {
  AutogradableCategory,
  AssignmentQuota,
  AssignmentVisibility,
} from "../enums";
import { useEffect } from "react";
import {
  addDays,
  attemptFormatEnum,
  formatDateForDateTimeLocalInput,
  setEndOfDay,
} from "../utils";

// Use the Zod schema from the import
type AssignmentFormData = typeof createAssignmentBodySchema._type;

// Define the component props interface
export interface AssignmentModalProps<T> {
  show: boolean;
  handleClose: () => void;
  handleSubmit: (data: T) => void;
  initialData?: T;
  disabled?: boolean;
  verb?: string;
}

const DEFAULT_NON_EXTENDABLE = [
  "nonstop_networking_pt3",
  "lovable_linux",
  "malloc_contest",
];

export default function AssignmentModal({
  show,
  handleClose,
  handleSubmit: onExternalSubmit,
  initialData,
  disabled,
  verb,
}: AssignmentModalProps<AssignmentFormData>) {
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    control,
    setValue,
  } = useForm<AssignmentFormData>({
    resolver: zodResolver(createAssignmentBodySchema),
    defaultValues: initialData || {
      name: "",
      id: "",
      visibility: AssignmentVisibility.DEFAULT,
      quotaPeriod: AssignmentQuota.DAILY,
      quotaAmount: 1,
      category: AutogradableCategory.MP,
      openAt: formatDateForDateTimeLocalInput(new Date()),
      dueAt: formatDateForDateTimeLocalInput(
        setEndOfDay(addDays(new Date(), 7)),
      ),
      jenkinsPipelineName: undefined,
      studentExtendable: true,
    },
    disabled,
  });

  const onSubmit = (data: AssignmentFormData) => {
    data.quotaAmount = Number(data.quotaAmount);
    if (data.jenkinsPipelineName?.trim() === "") {
      data.jenkinsPipelineName = undefined;
    }
    onExternalSubmit(data);
    reset();
    handleClose();
  };

  const nameValue = useWatch({
    control,
    name: "name",
  });
  useEffect(() => {
    if (nameValue) {
      const generatedId = nameValue
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replaceAll("part_", "pt")
        .replaceAll("week_", "week");
      setValue("id", generatedId);
    } else {
      setValue("id", "");
    }
  }, [nameValue, setValue]);

  // Watch the name field value
  const idWatch = useWatch({
    control,
    name: "id",
  });

  useEffect(() => {
    if (idWatch && DEFAULT_NON_EXTENDABLE.includes(idWatch)) {
      setValue("studentExtendable", false);
    } else {
      setValue("studentExtendable", true);
    }
  }, [idWatch, setValue]);

  return (
    <Modal show={show} onHide={handleClose}>
      <Form onSubmit={handleSubmit(onSubmit)}>
        <Modal.Header closeButton>
          <Modal.Title>{`${verb || "Create"} Assignment`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>Name</Form.Label>
            <Form.Control {...register("name")} isInvalid={!!errors.name} />
            <Form.Control.Feedback type="invalid">
              {errors.name?.message}
            </Form.Control.Feedback>
          </Form.Group>
          {!verb && (
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
                  {attemptFormatEnum(v)}
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
          <Form.Group className="mb-3">
            <Form.Label>Jenkins Pipeline ID</Form.Label>
            <Form.Control
              {...register("jenkinsPipelineName")}
              isInvalid={!!errors.jenkinsPipelineName}
            />
            <Form.Text className="text-muted">
              Leave empty for default pipeline ID.
            </Form.Text>
            <Form.Control.Feedback type="invalid">
              {errors.jenkinsPipelineName?.message}
            </Form.Control.Feedback>
          </Form.Group>
          <b>
            All times should be entered as your current timezone, and will be
            converted to the course timezone.
          </b>
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
            {verb || "Create"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
