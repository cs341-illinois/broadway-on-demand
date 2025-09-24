import {
  OverlayTrigger,
  Table,
  Tooltip,
  Form,
  Button,
  Row,
} from "react-bootstrap";
import { UserGradesResponse } from "../../types/grades";
import moment from "moment-timezone";
import { useForm } from "react-hook-form";
import { useState } from "react";
import ConfirmationModal from "./ConfirmationModal";
import { useAlert } from "../contexts/AlertContext";
import ViewStatsModal from "./ViewStatsModal";
import { formulateUrl } from "../utils";

export type GradeEditFunction = (
  data: GradesForm,
  justification: string,
) => void;
interface UserGradeTableProps {
  grades: UserGradesResponse;
  category: string;
  setGradeChanges?: GradeEditFunction;
  courseId: string;
}

export type GradesForm = {
  [assignmentId: string]: {
    score: number;
    comments?: string | null;
  };
};

const mapGrades = (grades: UserGradesResponse) => {
  let response: GradesForm = {};
  for (const item of grades) {
    response[item.id as keyof GradesForm] = {
      score: item.score,
      comments: item.comments,
    };
  }
  return response;
};

export function UserGradeTable({
  grades,
  category,
  setGradeChanges,
  courseId,
}: UserGradeTableProps) {
  const isEditable = Boolean(setGradeChanges);
  const { register, formState, getValues, reset } = useForm<GradesForm>({
    defaultValues: mapGrades(grades),
  });
  const [assignmentData, setAssignmentData] = useState<any[]>([]);
  const [confirmationModal, setConfirmationModal] = useState<boolean>(false);
  const [processing, setProcessing] = useState<boolean>(false);
  const [showViewStats, setShowViewStats] = useState<boolean>(false);
  const { errors, isDirty, dirtyFields } = formState;
  const { showAlert } = useAlert();
  const {
    register: registerJustification,
    formState: { errors: errorsJustification },
    getValues: getValuesJustification,
    handleSubmit: handleJustificationSubmit,
    reset: resetJustification,
  } = useForm<{ justification: string }>({
    defaultValues: { justification: undefined },
  });
  const getChangedAssignments = () => {
    const changedAssignments = Object.keys(dirtyFields);
    return Object.keys(getValues())
      .filter((key) => changedAssignments.includes(key))
      .reduce((obj, key) => {
        obj[key] = getValues()[key];
        return obj;
      }, {} as GradesForm);
  };
  const fetchAssignmentData = async (assignmentId: string) => {
    const response = await fetch(formulateUrl(`api/v1/courses/${courseId}/assignment/${assignmentId}/grades`));
    const data = await response.json();
    setAssignmentData(data.grades || []);
  };
  const handleViewStatsClick = async (assignmentId: string) => {
    await fetchAssignmentData(assignmentId);
    setShowViewStats(true);
  };

  return (
    <>
      <Table className="table table-striped">
        <thead>
          <tr>
            <th>Assignment</th>
            <th>Score</th>
            <th>Comments</th>
            <th>Last Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {grades
            .filter((x) => category === "all" || x.category === category)
            .map((x) => (
              <tr key={x.id}>
                <td>
                  {Object.keys(dirtyFields).includes(x.id) ? (
                    <b>{x.name}</b>
                  ) : (
                    x.name
                  )}
                </td>
                <td>
                  {isEditable ? (
                    <Form.Group>
                      <Form.Control
                        type="number"
                        min={0}
                        {...register(`${x.id}.score`, { valueAsNumber: true })}
                        isInvalid={!!errors[x.id]?.score}
                      />
                      <Form.Control.Feedback type="invalid">
                        {errors[x.id]?.score?.message}
                      </Form.Control.Feedback>
                    </Form.Group>
                  ) : (
                    <b>{x.score}</b>
                  )}
                </td>
                <td>
                  <span className="col-3 text-truncate">
                    {" "}
                    {isEditable ? (
                      <Form.Group>
                        <Form.Control
                          {...register(`${x.id}.comments`)}
                          isInvalid={!!errors[x.id]?.comments}
                        />
                        <Form.Control.Feedback type="invalid">
                          {errors[x.id]?.comments?.message}
                        </Form.Control.Feedback>
                      </Form.Group>
                    ) : (
                      <p className="text-wrap">{x.comments}</p>
                    )}
                  </span>
                </td>
                <OverlayTrigger
                  placement="bottom"
                  overlay={
                    <Tooltip id={`${x.id}-tooltop`}>
                      {x.updatedAt
                        ? moment(x.updatedAt).toLocaleString()
                        : "No data available."}
                    </Tooltip>
                  }
                >
                  <td>
                    {x.updatedAt ? (
                      moment(x.updatedAt).fromNow()
                    ) : (
                      <p className="text-muted">Never</p>
                    )}
                  </td>
                </OverlayTrigger>
                <td>
                    <Button onClick={() => handleViewStatsClick(x.id)}>View Stats</Button>
                </td>
              </tr>
            ))}
        </tbody>
      </Table>
      {showViewStats && (<ViewStatsModal show={showViewStats} data={(assignmentData.map(grade => grade.score))} onCancel={() => setShowViewStats(false)}/>)}
      {isDirty && setGradeChanges && (
        <>
          <Row className="d-flex align-items-end">
            <Form
              onSubmit={handleJustificationSubmit(() => {
                setConfirmationModal(true);
              })}
              className="d-flex align-items-end w-100"
            >
              <Form.Group
                controlId="justification"
                className="flex-grow-1 me-3"
              >
                <Form.Label>Justification for Changes</Form.Label>
                <Form.Control
                  type="text"
                  placeholder="Enter Justification"
                  {...registerJustification("justification", {
                    required: "Justification is required.",
                    minLength: 1,
                  })}
                  isInvalid={!!errorsJustification.justification}
                />
                <Form.Control.Feedback type="invalid">
                  {errorsJustification.justification?.message}
                </Form.Control.Feedback>
              </Form.Group>
              <Form.Group>
                <Button type="submit">Save Changes</Button>
              </Form.Group>
            </Form>
          </Row>
        </>
      )}
      {isDirty && setGradeChanges && (
        <ConfirmationModal
          show={confirmationModal}
          onCancel={() => {
            setConfirmationModal(false);
          }}
          title="Confirm Grade Change"
          message={
            <>
              <p>
                Please confirm that you would like to make changes to the
                following assignment grades:
              </p>
              <ul>
                {Object.keys(dirtyFields).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <b>
                Your NetID and justification will be logged with this action.
              </b>
            </>
          }
          isProcessing={processing}
          onConfirm={() => {
            setProcessing(true);
            try {
              const data = getValues();
              setGradeChanges(
                getChangedAssignments(),
                getValuesJustification().justification,
              );
              setConfirmationModal(false);
              reset({ ...data, ...getChangedAssignments() });
              resetJustification();
            } catch (e) {
              showAlert(
                "Your changes could not be saved. Please try again or contact the Infra team.",
                "danger",
              );
              throw e;
            } finally {
              setProcessing(false);
              showAlert("Your changes were saved.", "success");
            }
          }}
        />
      )}
    </>
  );
}
