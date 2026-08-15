from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GateKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GATE_KIND_UNSPECIFIED: _ClassVar[GateKind]
    GATE_KIND_PHASE: _ClassVar[GateKind]
    GATE_KIND_TOOL_CALL: _ClassVar[GateKind]
    GATE_KIND_QUESTION: _ClassVar[GateKind]
GATE_KIND_UNSPECIFIED: GateKind
GATE_KIND_PHASE: GateKind
GATE_KIND_TOOL_CALL: GateKind
GATE_KIND_QUESTION: GateKind

class ExecRequest(_message.Message):
    __slots__ = ("command", "working_dir")
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    WORKING_DIR_FIELD_NUMBER: _ClassVar[int]
    command: str
    working_dir: str
    def __init__(self, command: _Optional[str] = ..., working_dir: _Optional[str] = ...) -> None: ...

class ExecResponse(_message.Message):
    __slots__ = ("stdout", "stderr", "returncode")
    STDOUT_FIELD_NUMBER: _ClassVar[int]
    STDERR_FIELD_NUMBER: _ClassVar[int]
    RETURNCODE_FIELD_NUMBER: _ClassVar[int]
    stdout: str
    stderr: str
    returncode: int
    def __init__(self, stdout: _Optional[str] = ..., stderr: _Optional[str] = ..., returncode: _Optional[int] = ...) -> None: ...

class FileReadRequest(_message.Message):
    __slots__ = ("path",)
    PATH_FIELD_NUMBER: _ClassVar[int]
    path: str
    def __init__(self, path: _Optional[str] = ...) -> None: ...

class FileReadResponse(_message.Message):
    __slots__ = ("content",)
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    content: bytes
    def __init__(self, content: _Optional[bytes] = ...) -> None: ...

class FileWriteRequest(_message.Message):
    __slots__ = ("path", "content")
    PATH_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    path: str
    content: bytes
    def __init__(self, path: _Optional[str] = ..., content: _Optional[bytes] = ...) -> None: ...

class FileWriteResponse(_message.Message):
    __slots__ = ("bytes_written",)
    BYTES_WRITTEN_FIELD_NUMBER: _ClassVar[int]
    bytes_written: int
    def __init__(self, bytes_written: _Optional[int] = ...) -> None: ...

class GateRequest(_message.Message):
    __slots__ = ("kind", "phase_id", "phase_name", "tool_name", "side_effect_tier", "args_summary", "prompt", "options")
    KIND_FIELD_NUMBER: _ClassVar[int]
    PHASE_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_NAME_FIELD_NUMBER: _ClassVar[int]
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    SIDE_EFFECT_TIER_FIELD_NUMBER: _ClassVar[int]
    ARGS_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    kind: GateKind
    phase_id: str
    phase_name: str
    tool_name: str
    side_effect_tier: str
    args_summary: str
    prompt: str
    options: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, kind: _Optional[_Union[GateKind, str]] = ..., phase_id: _Optional[str] = ..., phase_name: _Optional[str] = ..., tool_name: _Optional[str] = ..., side_effect_tier: _Optional[str] = ..., args_summary: _Optional[str] = ..., prompt: _Optional[str] = ..., options: _Optional[_Iterable[str]] = ...) -> None: ...

class GateResponse(_message.Message):
    __slots__ = ("approved", "decision")
    APPROVED_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    approved: bool
    decision: str
    def __init__(self, approved: _Optional[bool] = ..., decision: _Optional[str] = ...) -> None: ...
