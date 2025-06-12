import { useState } from "react";
import { useForm } from "react-hook-form";
import { Modal, Button, Form, Badge } from "react-bootstrap";
import {
  createExtensionBody,
  AssignmentExtensionBody,
} from "../../types/assignment";
import { AssignmentQuota } from "../enums";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  addDays,
  formatDateForDateTimeLocalInput,
  setEndOfDay,
} from "../utils";
import moment from "moment-timezone";

// Define the component props interface
interface ExtensionModalProps {
  show: boolean;
  handleClose: () => void;
  handleSubmit: (data: AssignmentExtensionBody) => void;
  assignmentDue: Date;
}

export default function ExtensionModal({
  show,
  handleClose,
  handleSubmit: onExternalSubmit,
  assignmentDue,
}: ExtensionModalProps) {
  const [netIdInput, setNetIdInput] = useState<string>("");
  const [netIds, setNetIds] = useState<string[]>([]);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
  } = useForm<AssignmentExtensionBody>({
    resolver: zodResolver(createExtensionBody),
    defaultValues: {
      netIds: [],
      quotaPeriod: AssignmentQuota.DAILY,
      quotaAmount: 1,
      openAt: formatDateForDateTimeLocalInput(
        moment(assignmentDue).add({ second: 1 }).toDate(),
      ),
      closeAt: formatDateForDateTimeLocalInput(
        setEndOfDay(addDays(assignmentDue, 3)),
      ),
      createFinalGradingRun: true,
    },
  });

  const addNetId = () => {
    if (netIdInput.trim() && !netIds.includes(netIdInput.trim())) {
      const updatedNetIds = [...netIds, netIdInput.trim()];
      setNetIds(updatedNetIds);
      setValue("netIds", updatedNetIds);
      setNetIdInput("");
    }
  };

  const removeNetId = (index: number) => {
    const updatedNetIds = netIds.filter((_, i) => i !== index);
    setNetIds(updatedNetIds);
    setValue("netIds", updatedNetIds);
  };

  const onSubmit = (data: AssignmentExtensionBody) => {
    data.quotaAmount = Number(data.quotaAmount);
    onExternalSubmit(data);
    reset();
    setNetIds([]);
    handleClose();
  };

  const handleReset = () => {
    reset();
    setNetIds([]);
    handleClose();
  };

  return (
    <Modal show={show} onHide={handleClose}>
      <Form onSubmit={handleSubmit(onSubmit)}>
        <Modal.Header closeButton>
          <Modal.Title>Create Extension</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-3">
            <Form.Label>NetIDs</Form.Label>
            <div className="d-flex mb-2">
              <Form.Control
                value={netIdInput}
                onChange={(e) => setNetIdInput(e.target.value)}
                placeholder="Enter NetID"
                onKeyPress={(e) =>
                  e.key === "Enter" && (e.preventDefault(), addNetId())
                }
              />
              <Button
                variant="outline-secondary"
                onClick={addNetId}
                className="ms-2"
              >
                Add
              </Button>
            </div>

            {netIds.length > 0 && (
              <div className="mb-2">
                {netIds.map((id, index) => (
                  <Badge bg="primary" className="me-1 mb-1 p-2" key={index}>
                    {id}
                    <span
                      className="ms-2"
                      style={{ cursor: "pointer" }}
                      onClick={() => removeNetId(index)}
                    >
                      ×
                    </span>
                  </Badge>
                ))}
              </div>
            )}

            {errors.netIds && (
              <Form.Text className="text-danger">
                {errors.netIds.message}
              </Form.Text>
            )}
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
            <Form.Label>Closes At</Form.Label>
            <Form.Control
              type="datetime-local"
              {...register("closeAt", { required: "Close date is required" })}
              isInvalid={!!errors.closeAt}
            />
            <Form.Control.Feedback type="invalid">
              {errors.closeAt?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <Form.Group className="mb-3">
            <Form.Label>Create Final Grading Run?</Form.Label>
            <Form.Check
              type="switch"
              {...register("createFinalGradingRun", {
                required: "You must specify this field",
              })}
              isInvalid={!!errors.createFinalGradingRun}
            />
            <Form.Control.Feedback type="invalid">
              {errors.createFinalGradingRun?.message}
            </Form.Control.Feedback>
          </Form.Group>

          <b>
            All times are entered as your current timezone and will be converted
            to the course timezone.
          </b>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleReset}>
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
