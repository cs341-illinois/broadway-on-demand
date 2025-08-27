import {
  useState,
  useEffect,
  Suspense,
  useMemo,
  SetStateAction,
  Dispatch,
} from "react";
import {
  Button,
  Card,
  Col,
  Container,
  Row,
  Table,
  Form,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";
import moment from "moment-timezone";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
  dateTimeFormatString,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  getTimeZoneName,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import ConfirmationModal from "../components/ConfirmationModal";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";

import {
  AssignmentQuotaLabels,
} from "../../types/assignment";
import {
  SelfExtensionsGetResponse,
  selfExtensionsResponseSchema,
} from "../../types/extension";

async function getCurrentExtensionData(
  courseId: string,
): Promise<SelfExtensionsGetResponse> {
  if (!courseId) {
    throw new Error("Course ID is missing for fetching extension data.");
  }
  const response = await fetch(
    formulateUrl(`api/v1/extension/${courseId}/self`),
  );
  if (!response.ok) {
    let errorMessage = `Failed to load extension data. Status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorData.detail || errorMessage;
    } catch (e) {
      /* Ignore parsing error of error body */
    }
    throw new Error(errorMessage);
  }
  const jsonData = await response.json();
  const result = await selfExtensionsResponseSchema.safeParseAsync(jsonData);

  if (!result.success) {
    console.error("Zod parsing error for extensions:", result.error.flatten());
    throw new Error(
      "Failed to parse self-extensions data: " + result.error.message,
    );
  }
  return result.data;
}

interface SelfExtensionsContentProps {
  extensionPageResource: Resource<SelfExtensionsGetResponse>;
  courseId: string;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
  setResourceKey: Dispatch<SetStateAction<number>>; // To trigger refresh
}

function SelfExtensionsContent({
  extensionPageResource,
  courseId,
  showAlert,
  setResourceKey,
}: SelfExtensionsContentProps) {
  const extensionData = extensionPageResource.read(); // This will suspend

  const [confirmModal, setConfirmModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const formSchema = z.object({
    assignmentId: z
      .string()
      .min(1, "You must select an assignment to continue.")
      .refine(
        (x) => extensionData.visibleAssignments.map((y) => y.id).includes(x),
        "Invalid Assignment ID. The selected assignment may no longer be eligible.",
      ),
  });

  type FormData = z.infer<typeof formSchema>;

  const {
    register,
    handleSubmit,
    formState: { errors },
    getValues,
    reset,
  } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      assignmentId: extensionData.visibleAssignments[0]?.id || "",
    },
  });

  // Effect to reset form if extensionData changes (e.g. after refresh showing new eligible assignments)
  useEffect(() => {
    reset({
      assignmentId: extensionData.visibleAssignments[0]?.id || "",
    });
  }, [extensionData, reset]);

  const handleFormSubmitLogic = async () => {
    setIsProcessing(true);
    try {
      const assignmentId = getValues().assignmentId;
      // Double check eligibility based on current form values against potentially stale extensionData
      // This is mostly covered by zod refine, but an extra check can be good defense
      const selectedAssignment = extensionData.visibleAssignments.find(
        (a) => a.id === assignmentId,
      );
      if (!selectedAssignment) {
        showAlert(
          "Selected assignment is no longer available for extension. Please refresh and try again.",
          "warning",
        );
        setConfirmModal(false);
        setIsProcessing(false);
        return;
      }

      const response = await fetch(
        formulateUrl(
          `api/v1/extension/${courseId}/assignment/${assignmentId}/self`,
        ),
        { method: "POST", credentials: "include" },
      );

      if (!response.ok) {
        const errorText = await response.text();
        showAlert(
          `Failed to create extension: ${errorText || "Please contact course staff."}`,
          "warning",
        );
        // Do not close modal or clear processing here if user might retry or needs to see error
        return;
      }
      showAlert("Extension successfully applied!", "success");
      setConfirmModal(false);
      setResourceKey((k) => k + 1);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "An unknown error occurred.";
      showAlert(`An error occurred: ${message}`, "danger");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      <AppNavbar
        title={extensionData.courseName}
        breadcrumb={{
          items: [
            {
              label: "Course Home",
              href: formulateUrl(`dashboard/${courseId}`),
            },
            { label: "Apply Extension" },
          ],
        }}
      />
      <Container className="p-2 flex-grow-1">
        <Row>
          <Col lg={6} md={12} className="mb-3 mb-lg-0">
            <h2>Current Extensions</h2>
            {extensionData.userAppliedExtensions.length === 0 && (
              <p className="text-muted">No existing extensions.</p>
            )}
            {extensionData.userAppliedExtensions.length > 0 && (
              <>
                <p className="text-muted">
                  This list does not include any extensions granted by course
                  staff.
                </p>
                <Table striped hover responsive>
                  <thead>
                    <tr>
                      <th>Assignment</th>
                      <th>Runs</th>
                      <th>Extended To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extensionData.userAppliedExtensions.map((ext) => (
                      <tr key={ext.assignmentId}>
                        <td>{ext.name}</td>
                        <td>
                          {ext.quotaAmount} (
                          {AssignmentQuotaLabels[ext.quotaPeriod]})
                        </td>
                        <td>
                          {moment(ext.closeAt).format(dateTimeFormatString)}
                          <p className="text-muted">
                            {moment(ext.closeAt).fromNow()}
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Col>

          <Col lg={6} md={12}>
            <h2>Apply an Extension</h2>
            <Card>
              <Card.Body>
                <ul className="small">
                  <li>
                    You may apply up to{" "}
                    <b>
                      {extensionData.userAppliedExtensions.length +
                        extensionData.numExtensionsRemaining}
                    </b>{" "}
                    no-questions-asked extensions per semester (
                    {extensionData.numExtensionsRemaining} remaining now).
                  </li>
                  <li>
                    You will receive a{" "}
                    <b>{extensionData.numExtensionHours}-hour</b> extension from
                    the assignment due date.
                  </li>
                  <ul>
                    <li>
                      No extension may extend the due date of your assignment
                      past Reading Day (
                      {moment(extensionData.courseCutoff).format(
                        "ddd, MMM D, YYYY, h:mm A",
                      )}
                      ).
                    </li>
                  </ul>
                  <li>
                    You will receive the same number of runs as the original
                    assignment.
                  </li>
                  <li>
                    You may apply up to one extension per assignment, and the
                    assignment must be open when you apply the extension.
                  </li>
                  <li>
                    You may not apply extensions on assignments outside of the
                    Broadway On Demand autograder.
                  </li>
                  <ul>
                    <li>
                      Examples include HW0, PrairieLearn quizzes, and pre-labs.
                    </li>
                  </ul>
                </ul>
                <p className="text-danger small">
                  This extension cannot be reverted - please be sure you want to
                  apply an extension before submitting!
                </p>
                {extensionData.visibleAssignments.length === 0 && (
                  <p className="text-muted">
                    No assignments available to self-extend.
                  </p>
                )}
                {extensionData.visibleAssignments.length > 0 && (
                  <Form
                    onSubmit={handleSubmit(() => {
                      setConfirmModal(true);
                    })}
                  >
                    <Form.Group className="mb-3" controlId="assignmentIdSelect">
                      <Form.Label>Select assignment</Form.Label>
                      <Form.Select
                        {...register("assignmentId")}
                        isInvalid={!!errors.assignmentId}
                      >
                        {extensionData.visibleAssignments.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name} (currently due{" "}
                            {moment(x.dueAt).format(dateTimeFormatString)})
                          </option>
                        ))}
                      </Form.Select>
                      <Form.Control.Feedback type="invalid">
                        {errors.assignmentId?.message}
                      </Form.Control.Feedback>
                    </Form.Group>
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={
                        isProcessing ||
                        extensionData.numExtensionsRemaining === 0
                      }
                    >
                      {isProcessing ? "Processing..." : "Apply Extension"}
                    </Button>
                    {extensionData.numExtensionsRemaining === 0 && (
                      <p className="text-warning small mt-2">
                        You have no extensions remaining.
                      </p>
                    )}
                  </Form>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>
        <Row className="mt-3">
          <Col>
            <p className="text-muted small">
              All timestamps shown in your local timezone (
              {getTimeZoneName()}).
            </p>
          </Col>
        </Row>
      </Container>
      {/* Confirmation Modal - its content depends on getValues() and extensionData */}
      {/* We need to ensure getValues().assignmentId is valid before trying to access array elements */}
      {confirmModal &&
        getValues().assignmentId &&
        extensionData.visibleAssignments.find(
          (x) => x.id === getValues().assignmentId,
        ) && (
          <ConfirmationModal
            show={confirmModal}
            title="Confirm Extension"
            message={
              <>
                <p>
                  Are you sure you would like to apply an extension for the{" "}
                  <b>
                    {
                      extensionData.visibleAssignments.find(
                        (x) => x.id === getValues().assignmentId,
                      )!.name // ! is okay due to the find in the conditional render
                    }
                  </b>{" "}
                  assignment? Your due date will be extended to approximately{" "}
                  <b>
                    {moment(
                      extensionData.visibleAssignments.find(
                        (x) => x.id === getValues().assignmentId,
                      )!.dueAt,
                    )
                      .tz(Intl.DateTimeFormat().resolvedOptions().timeZone) // Display in user's local TZ
                      .add({ hours: extensionData.numExtensionHours })
                      .format("MM/DD/YYYY hh:mm A z")}
                  </b>
                  . The exact new deadline will be confirmed upon application
                  and may be capped by the course cutoff date.
                </p>
                <b className="text-danger">
                  This extension cannot be reverted. Please be absolutely sure!
                </b>
              </>
            }
            confirmText="Yes, Apply Extension"
            isProcessing={isProcessing}
            onConfirm={handleFormSubmitLogic}
            onCancel={() => setConfirmModal(false)}
          />
        )}
    </>
  );
}

// --- Main Page Component ---
export default function SelfExtensionsPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert(); // showAlert will be passed down

  const [resourceKey, setResourceKey] = useState<number>(0);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);

  useEffect(() => {
    if (!user) return;

    if (!courseId || courseRoles.length === 0) {
      showAlert(
        "The specified course does not exist or you do not have access.",
        "danger",
      );
      navigate(formulateUrl("dashboard"));
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Apply Extension | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate, showAlert]);

  const extensionPageResource = useMemo<
    Resource<SelfExtensionsGetResponse>
  >(() => {
    return createResource<SelfExtensionsGetResponse>(() =>
      getCurrentExtensionData(courseId),
    );
  }, [courseId, user?.id, resourceKey]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <SelfExtensionsContent
            extensionPageResource={extensionPageResource}
            courseId={courseId}
            showAlert={showAlert}
            setResourceKey={setResourceKey}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
