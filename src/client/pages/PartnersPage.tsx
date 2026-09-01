import { useEffect, useMemo, useState, Suspense } from "react";
import {
  Container,
  Card,
  Button,
  Row,
  Col,
  Table,
  Modal,
  Form,
  Badge,
  Spinner,
  Nav,
  InputGroup,
} from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../contexts/AuthContext";
import { useAlert } from "../contexts/AlertContext";
import {
  createResource,
  formulateUrl,
  getCourseInfo,
  getCourseRoles,
  Resource,
  setCourseInfoSessionStorage,
} from "../utils";
import AppNavbar from "../components/Navbar";
import ConfirmationModal from "../components/ConfirmationModal";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingScreen } from "../components/Loading";
import { CourseInformationResponse } from "../../types/assignment";
import { Role } from "../enums";
import { PARTNER_MAX_ROUNDS } from "../../constants";
import {
  PartnerGroupEntry,
  PartnersForRoundResponse,
  MyPartnerGroupResponse,
} from "../../types/partners";

const ROUNDS = Array.from({ length: PARTNER_MAX_ROUNDS }, (_, i) => i + 1);

interface PartnersPageData {
  courseDetails: CourseInformationResponse;
  roundNumber: number;
  partners: PartnersForRoundResponse;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(formulateUrl(url), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

async function getPartnersPageData(
  courseId: string,
  roundNumber: number,
): Promise<PartnersPageData> {
  const [courseDetails, partners] = await Promise.all([
    fetchJson<CourseInformationResponse>(`api/v1/courses/${courseId}`),
    fetchJson<PartnersForRoundResponse>(
      `api/v1/partners/${courseId}/round/${roundNumber}`,
    ),
  ]);
  return { courseDetails, roundNumber, partners };
}

function groupsBySection(groups: PartnerGroupEntry[]) {
  const bySection = new Map<string, PartnerGroupEntry[]>();
  for (const group of groups) {
    const list = bySection.get(group.labSection) ?? [];
    list.push(group);
    bySection.set(group.labSection, list);
  }
  return bySection;
}

function groupsToTextarea(groups: PartnerGroupEntry[]) {
  return groups
    .map((g) => g.members.map((m) => m.netId).join(", "))
    .join("\n");
}

function memberLabel(member: { netId: string; name: string | null }) {
  return member.name ? `${member.name} (${member.netId})` : member.netId;
}

function parseTextareaToGroups(text: string): string[][] {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(",")
        .map((netId) => netId.trim())
        .filter(Boolean),
    )
    .filter((group) => group.length > 0);
}

interface ContentProps {
  resource: Resource<PartnersPageData>;
  courseId: string;
  isAdmin: boolean;
  showAlert: ReturnType<typeof useAlert>["showAlert"];
  refresh: () => void;
  selectedRound: number;
  setSelectedRound: (round: number) => void;
}

function HistoryModal({
  show,
  onHide,
  title,
  entries,
  loading,
}: {
  show: boolean;
  onHide: () => void;
  title: string;
  entries: PartnerGroupEntry[] | null;
  loading: boolean;
}) {
  return (
    <Modal show={show} onHide={onHide} size="lg">
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {loading ? (
          <Spinner animation="border" size="sm" />
        ) : entries && entries.length > 0 ? (
          <Table responsive striped bordered hover size="sm">
            <thead>
              <tr>
                <th>Round</th>
                <th>Members</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.roundNumber}</td>
                  <td>
                    {entry.members.map((member) => (
                      <Badge bg="secondary" className="me-1" key={member.netId}>
                        {memberLabel(member)}
                      </Badge>
                    ))}
                  </td>
                  <td>
                    {new Date(entry.createdAt).toLocaleString()} by{" "}
                    {entry.createdBy}
                  </td>
                  <td>
                    {entry.archivedAt ? (
                      <span className="text-muted">
                        Replaced {new Date(entry.archivedAt).toLocaleString()}
                        {entry.archivedBy ? ` by ${entry.archivedBy}` : ""}
                      </span>
                    ) : (
                      <Badge bg="success">Active</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-muted mb-0">No history found.</p>
        )}
      </Modal.Body>
    </Modal>
  );
}

function PartnersContent({
  resource,
  courseId,
  isAdmin,
  showAlert,
  refresh,
  selectedRound,
  setSelectedRound,
}: ContentProps) {
  const { courseDetails, roundNumber, partners } = resource.read();
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    run: () => Promise<void>;
  } | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  const [historyModal, setHistoryModal] = useState<{
    title: string;
    entries: PartnerGroupEntry[] | null;
    loading: boolean;
  } | null>(null);

  const [lookupNetId, setLookupNetId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  const bySection = useMemo(
    () => groupsBySection(partners.groups),
    [partners.groups],
  );
  const sections = useMemo(
    () => [...new Set([...partners.sections, ...bySection.keys()])].sort(),
    [partners.sections, bySection],
  );

  const openEditModal = (labSection: string) => {
    setEditingSection(labSection);
    setEditingText(groupsToTextarea(bySection.get(labSection) ?? []));
  };

  const saveSection = async (labSection: string, groups: string[][]) => {
    await fetchJson(
      `api/v1/partners/${courseId}/round/${roundNumber}/section/${labSection}`,
      { method: "PUT", body: JSON.stringify({ groups }) },
    );
    showAlert(`Saved groups for section ${labSection}.`, "success");
    refresh();
  };

  const handleSaveSection = async () => {
    if (!editingSection) return;
    const groups = parseTextareaToGroups(editingText);
    if (groups.length === 0) {
      showAlert("You must specify at least one group.", "warning");
      return;
    }
    const hasExisting = (bySection.get(editingSection) ?? []).length > 0;
    setIsSaving(true);
    try {
      if (hasExisting) {
        setEditingSection(null);
        setConfirmAction({
          title: `Replace Round ${roundNumber} groups for section ${editingSection}`,
          message: `This replaces the current Round ${roundNumber} pairings for section ${editingSection}. Previous pairings stay viewable in history.`,
          run: () => saveSection(editingSection, groups),
        });
      } else {
        await saveSection(editingSection, groups);
        setEditingSection(null);
      }
    } catch (error) {
      showAlert((error as Error).message || "Failed to save groups.", "danger");
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerate = async (labSection: string) => {
    try {
      await fetchJson(
        `api/v1/partners/${courseId}/round/${roundNumber}/section/${labSection}/generate`,
        { method: "POST" },
      );
      showAlert(`Generated groups for section ${labSection}.`, "success");
      refresh();
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to generate groups.",
        "danger",
      );
    }
  };

  const handleRegenerate = (labSection: string) => {
    setConfirmAction({
      title: `Regenerate Round ${roundNumber} groups for section ${labSection}`,
      message: `This re-randomizes all pairings for section ${labSection}, Round ${roundNumber}, and replaces the current pairings. Previous pairings stay viewable in history.`,
      run: async () => {
        await fetchJson(
          `api/v1/partners/${courseId}/round/${roundNumber}/section/${labSection}/regenerate`,
          { method: "POST" },
        );
        showAlert(`Regenerated groups for section ${labSection}.`, "success");
        refresh();
      },
    });
  };

  const handleRunConfirmedAction = async () => {
    if (!confirmAction) return;
    setIsConfirming(true);
    try {
      await confirmAction.run();
      setConfirmAction(null);
    } catch (error) {
      showAlert((error as Error).message || "Action failed.", "danger");
    } finally {
      setIsConfirming(false);
    }
  };

  const openSectionHistory = async (labSection: string) => {
    setHistoryModal({
      title: `History: Section ${labSection}, Round ${roundNumber}`,
      entries: null,
      loading: true,
    });
    try {
      const entries = await fetchJson<PartnerGroupEntry[]>(
        `api/v1/partners/${courseId}/round/${roundNumber}/section/${labSection}/history`,
      );
      setHistoryModal({
        title: `History: Section ${labSection}, Round ${roundNumber}`,
        entries,
        loading: false,
      });
    } catch (error) {
      showAlert((error as Error).message || "Failed to load history.", "danger");
      setHistoryModal(null);
    }
  };

  const handleLookupStudent = async () => {
    if (!lookupNetId.trim()) return;
    setLookupLoading(true);
    setHistoryModal({
      title: `History: ${lookupNetId.trim()}`,
      entries: null,
      loading: true,
    });
    try {
      const entries = await fetchJson<PartnerGroupEntry[]>(
        `api/v1/partners/${courseId}/student/${lookupNetId.trim()}/history`,
      );
      setHistoryModal({
        title: `History: ${lookupNetId.trim()}`,
        entries,
        loading: false,
      });
    } catch (error) {
      showAlert(
        (error as Error).message || "Failed to load student history.",
        "danger",
      );
      setHistoryModal(null);
    } finally {
      setLookupLoading(false);
    }
  };

  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Lab Partners" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <Row className="mb-3 align-items-center">
          <Col>
            <h1>Lab Partners</h1>
            <p className="text-muted mb-0">
              Rounds are generated on demand - tag a Lab assignment with a
              round to have it use these pairings.
            </p>
          </Col>
        </Row>

        <Nav variant="tabs" className="mb-4">
          {ROUNDS.map((round) => (
            <Nav.Item key={round}>
              <Nav.Link
                active={round === selectedRound}
                onClick={() => setSelectedRound(round)}
              >
                Round {round}
              </Nav.Link>
            </Nav.Item>
          ))}
        </Nav>

        {isAdmin && (
          <Card className="mb-4">
            <Card.Body>
              <Form.Label className="mb-1">
                Look up a student's full pairing history
              </Form.Label>
              <InputGroup>
                <Form.Control
                  placeholder="netid"
                  value={lookupNetId}
                  onChange={(e) => setLookupNetId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLookupStudent()}
                />
                <Button
                  variant="outline-secondary"
                  onClick={handleLookupStudent}
                  disabled={lookupLoading || !lookupNetId.trim()}
                >
                  {lookupLoading ? (
                    <Spinner as="span" size="sm" animation="border" />
                  ) : (
                    "Look up"
                  )}
                </Button>
              </InputGroup>
            </Card.Body>
          </Card>
        )}

        {partners.ungroupedNetIds.length > 0 && (
          <Card bg="warning" text="dark" className="mb-4">
            <Card.Body>
              <strong>Ungrouped students ({partners.ungroupedNetIds.length}):</strong>{" "}
              {partners.ungroupedNetIds.join(", ")}
            </Card.Body>
          </Card>
        )}

        {sections.length === 0 && (
          <p className="text-muted">
            No lab sections found for this course yet. Import lab sections
            through the course roster page.
          </p>
        )}

        {sections.map((labSection) => {
          const groups = bySection.get(labSection) ?? [];
          const hasGroups = groups.length > 0;
          return (
            <Row className="mb-4" key={labSection}>
              <Col>
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <h3>Section {labSection}</h3>
                  {isAdmin && (
                    <div>
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        className="me-2"
                        onClick={() => openSectionHistory(labSection)}
                      >
                        History
                      </Button>
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        className="me-2"
                        onClick={() => openEditModal(labSection)}
                      >
                        Edit
                      </Button>
                      {hasGroups ? (
                        <Button
                          variant="outline-danger"
                          size="sm"
                          onClick={() => handleRegenerate(labSection)}
                        >
                          Regenerate
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleGenerate(labSection)}
                        >
                          Generate
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <Card>
                  {hasGroups ? (
                    <Table responsive striped bordered hover size="sm" className="mb-0">
                      <thead>
                        <tr>
                          <th>Members</th>
                          <th>Created By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((group) => (
                          <tr key={group.id}>
                            <td>
                              {group.members.map((member) => (
                                <Badge
                                  bg="secondary"
                                  className="me-1"
                                  key={member.netId}
                                >
                                  {memberLabel(member)}
                                </Badge>
                              ))}
                            </td>
                            <td>{group.createdBy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <Card.Body className="text-muted">
                      No groups yet for this section, Round {roundNumber}.
                      {isAdmin && ' Click "Generate" above to create them.'}
                    </Card.Body>
                  )}
                </Card>
              </Col>
            </Row>
          );
        })}

        <Modal show={editingSection !== null} onHide={() => !isSaving && setEditingSection(null)} size="lg">
          <Modal.Header closeButton={!isSaving}>
            <Modal.Title>Edit Section {editingSection}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className="text-muted">
              One group per line, netIds separated by commas (2-3 per group).
              This replaces every active group in this section for Round {roundNumber}.
            </p>
            <Form.Control
              as="textarea"
              rows={10}
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              disabled={isSaving}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setEditingSection(null)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSaveSection} disabled={isSaving}>
              {isSaving ? <Spinner as="span" size="sm" animation="border" /> : "Save"}
            </Button>
          </Modal.Footer>
        </Modal>

        <ConfirmationModal
          show={confirmAction !== null}
          title={confirmAction?.title ?? ""}
          message={confirmAction?.message ?? ""}
          confirmText="Replace pairings"
          isProcessing={isConfirming}
          onConfirm={handleRunConfirmedAction}
          onCancel={() => setConfirmAction(null)}
        />

        <HistoryModal
          show={historyModal !== null}
          onHide={() => setHistoryModal(null)}
          title={historyModal?.title ?? ""}
          entries={historyModal?.entries ?? null}
          loading={historyModal?.loading ?? false}
        />
      </Container>
    </>
  );
}

function StudentPartnersContent({
  resource,
  courseId,
  currentUserNetId,
}: {
  resource: Resource<{ courseDetails: CourseInformationResponse; me: MyPartnerGroupResponse }>;
  courseId: string;
  currentUserNetId: string | undefined;
}) {
  const { courseDetails, me } = resource.read();
  const breadcrumb = {
    items: [
      { label: "Course Home", href: formulateUrl(`dashboard/${courseId}`) },
      { label: "Lab Partners" },
    ],
  };

  return (
    <>
      <AppNavbar title={courseDetails.name} breadcrumb={breadcrumb} />
      <Container className="p-3 mb-5 flex-grow-1">
        <h1>My Lab Partners</h1>
        {me.labSection ? (
          <p className="text-muted">
            Lab section: <Badge bg="secondary">{me.labSection}</Badge>
          </p>
        ) : (
          <p className="text-muted">You aren't assigned to a lab section yet.</p>
        )}
        {me.rounds.map(({ roundNumber, group }) => {
          const others = (group?.members ?? []).filter(
            (member) => member.netId !== currentUserNetId,
          );
          return (
            <Card className="mt-3" key={roundNumber}>
              <Card.Header as="h5">Round {roundNumber}</Card.Header>
              <Card.Body>
                {group ? (
                  others.length > 0 ? (
                    <p className="mb-0">
                      Your partner{others.length > 1 ? "s" : ""}:{" "}
                      {others.map((member) => (
                        <Badge bg="primary" className="me-1" key={member.netId}>
                          {memberLabel(member)}
                        </Badge>
                      ))}
                    </p>
                  ) : (
                    <p className="text-muted mb-0">
                      You're in a group by yourself this round - no partner assigned.
                    </p>
                  )
                ) : (
                  <p className="text-muted mb-0">
                    No partner group assigned yet for this round.
                  </p>
                )}
              </Card.Body>
            </Card>
          );
        })}
      </Container>
    </>
  );
}

export default function PartnersPage(): JSX.Element {
  const { user } = useAuth();
  const { courseId = "" } = useParams<{ courseId?: string }>();
  const navigate = useNavigate();
  const { showAlert } = useAlert();
  const [resourceKey, setResourceKey] = useState(0);
  const [selectedRound, setSelectedRound] = useState(1);

  const courseRoles = useMemo(() => {
    if (!user?.roles) return [];
    return getCourseRoles(courseId, user.roles);
  }, [courseId, user]);
  const isStaffOrAdmin = useMemo(
    () => courseRoles.includes(Role.ADMIN) || courseRoles.includes(Role.STAFF),
    [courseRoles],
  );
  const isAdmin = useMemo(() => courseRoles.includes(Role.ADMIN), [courseRoles]);
  const currentUserNetId = useMemo(() => user?.email?.split("@")[0], [user]);

  useEffect(() => {
    if (!user) return;
    if (!courseId || courseRoles.length === 0) {
      showAlert("You do not have permission to view this page.", "danger");
      navigate(formulateUrl("dashboard"));
      return;
    }
    const courseInfo = getCourseInfo(user, courseId)!;
    setCourseInfoSessionStorage(courseInfo);
    document.title = `Lab Partners | ${courseInfo.courseName}`;
  }, [courseId, user, courseRoles, navigate, showAlert]);

  const staffResource = useMemo<Resource<PartnersPageData>>(() => {
    if (!courseId || !isStaffOrAdmin) {
      return createResource<PartnersPageData>(() =>
        Promise.reject(new Error("Access denied.")),
      );
    }
    return createResource<PartnersPageData>(() =>
      getPartnersPageData(courseId, selectedRound),
    );
  }, [courseId, isStaffOrAdmin, resourceKey, selectedRound]);

  const studentResource = useMemo<
    Resource<{ courseDetails: CourseInformationResponse; me: MyPartnerGroupResponse }>
  >(() => {
    if (!courseId || isStaffOrAdmin) {
      return createResource(() => Promise.reject(new Error("Access denied.")));
    }
    return createResource(async () => {
      const [courseDetails, me] = await Promise.all([
        fetchJson<CourseInformationResponse>(`api/v1/courses/${courseId}`),
        fetchJson<MyPartnerGroupResponse>(`api/v1/partners/${courseId}/me`),
      ]);
      return { courseDetails, me };
    });
  }, [courseId, isStaffOrAdmin, resourceKey]);

  if (!user) {
    return <LoadingScreen message="Loading user data..." />;
  }
  if (!courseId || courseRoles.length === 0) {
    return <LoadingScreen message="Checking permissions..." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          {isStaffOrAdmin ? (
            <PartnersContent
              resource={staffResource}
              courseId={courseId}
              isAdmin={isAdmin}
              showAlert={showAlert}
              refresh={() => setResourceKey((k) => k + 1)}
              selectedRound={selectedRound}
              setSelectedRound={setSelectedRound}
            />
          ) : (
            <StudentPartnersContent
              resource={studentResource}
              courseId={courseId}
              currentUserNetId={currentUserNetId}
            />
          )}
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
