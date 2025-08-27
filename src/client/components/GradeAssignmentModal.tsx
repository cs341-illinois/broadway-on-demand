import { Modal, Button } from "react-bootstrap";
import { AssignmentInformationResponse } from "../../types/assignment";

interface GradeAssignmentModalProps {
  show: boolean;
  handleClose: () => void;
  handleGrade: (latestCommitHash: string) => void;
  latestCommit: AssignmentInformationResponse["latestCommit"];
}

export default function GradeAssignmentModal({
  show,
  handleClose,
  handleGrade,
  latestCommit,
}: GradeAssignmentModalProps) {
  return (
    <Modal show={show} onHide={handleClose}>
      <Modal.Header closeButton>
        <Modal.Title>Confirm Grading</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          The latest commit in your repository (commit SHA{" "}
          <b>{latestCommit?.sha.slice(0, 7)}</b>) will be graded, using 1
          available run.
        </p>
        <p>
          In addition, by proceeding{" "}
          <b>
            you certify that you have read and understand the course policies
            regarding plagiarism and academic integrity
          </b>{" "}
          and that the work you are submitting is your own and original unless
          explicitly allowed otherwise.
        </p>
        <p>Are you sure you want to proceed?</p>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={handleClose} variant="secondary">
          Close
        </Button>
        <Button
          onClick={() => handleGrade(latestCommit?.sha || "")}
          variant="primary"
        >
          Yes, Grade Now
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
